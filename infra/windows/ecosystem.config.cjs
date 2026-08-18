/* eslint-disable */
/**
 * ===========================================================================
 * BrandLens · PM2 process definitions
 *
 * Four processes, one VM, no Docker:
 *
 *   brandlens-api      NestJS control plane          :4000
 *   brandlens-worker   pg-boss queue consumer        (no port)
 *   brandlens-web      Next.js console               :3000
 *   brandlens-engine   Python FastAPI analysis       :8000
 *
 * Usage:
 *   pm2 start infra/windows/ecosystem.config.cjs
 *   pm2 start infra/windows/ecosystem.config.cjs --only brandlens-api
 *   pm2 reload infra/windows/ecosystem.config.cjs   # zero-downtime for node apps
 *   pm2 save                                        # persist across reboot
 *
 * WINDOWS NOTES
 *
 * 1. Every path is absolute and built with path.join, so it is correct with
 *    backslashes on Windows and forward slashes on Linux/macOS. PM2 resolves a
 *    relative `script` against its own cwd, not the config file's, which is
 *    the usual cause of "Script not found" on a service-managed PM2.
 *
 * 2. `exec_mode: 'fork'` everywhere. PM2's cluster mode depends on Node's
 *    cluster module: it cannot host a Python process at all, and for the
 *    worker it would be actively wrong — pg-boss already fans out internally
 *    per pool, and cluster-forking it would multiply the configured
 *    concurrency by the instance count without anyone asking for it.
 *
 * 3. The Python engine is launched as `<venv>\Scripts\python.exe -m uvicorn`
 *    with `interpreter: 'none'`, i.e. PM2 execs the interpreter directly
 *    rather than trying to run the script under Node. Pointing `interpreter`
 *    at python and `script` at a module name does not work — PM2 stats the
 *    script path first and refuses a name that is not a file.
 *
 * 4. `.env` is parsed here and injected into each process's environment.
 *    PM2's own `env_file` key only exists in recent releases and is silently
 *    ignored by older ones, which produces a service that starts happily with
 *    no configuration. Reading the file ourselves makes the behaviour the
 *    same on every PM2 version, and lets us fail loudly when it is absent.
 * ===========================================================================
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const isWindows = process.platform === 'win32';

/* -------------------------------------------------------------------------
 * .env
 * ---------------------------------------------------------------------- */

/**
 * Minimal dotenv parser. Deliberately not a dependency: this file is read by
 * PM2 itself, possibly running as a Windows service account with a different
 * global node_modules, so it must work with nothing but Node builtins.
 */
function parseDotEnv(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const ENV_FILE = path.join(ROOT, '.env');
const fileEnv = parseDotEnv(ENV_FILE);

if (!fs.existsSync(ENV_FILE)) {
  // A warning, not a throw: `pm2 delete` and `pm2 stop` also load this file,
  // and refusing to parse it would make the config unusable for teardown.
  process.stderr.write(
    `\n[brandlens] WARNING: ${ENV_FILE} not found. Processes will start with defaults only.\n` +
      `[brandlens] Copy .env.example to .env before starting anything.\n\n`,
  );
}

/** .env is the source of truth; a real process variable still wins. */
function env(key, fallback) {
  return process.env[key] || fileEnv[key] || fallback;
}

const NODE_ENV = env('NODE_ENV', 'production');
const LOG_DIR = path.join(ROOT, 'logs');

if (!fs.existsSync(LOG_DIR)) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    /* PM2 creates the files itself; a read-only checkout is not fatal here. */
  }
}

/** Environment shared by all four processes. */
const sharedEnv = { ...fileEnv, NODE_ENV, BRANDLENS_ROOT: ROOT };

/* -------------------------------------------------------------------------
 * Path resolution
 * ---------------------------------------------------------------------- */

const API_DIR = path.join(ROOT, 'apps', 'api');
const WORKER_DIR = path.join(ROOT, 'apps', 'worker');
const WEB_DIR = path.join(ROOT, 'apps', 'web');
const ENGINE_DIR = path.join(ROOT, 'apps', 'engine');

/** Built entrypoints. `nest build`/`tsc` emit under dist/apps/<app>/src. */
const API_ENTRY = path.join(API_DIR, 'dist', 'apps', 'api', 'src', 'main.js');
const WORKER_ENTRY = path.join(WORKER_DIR, 'dist', 'apps', 'worker', 'src', 'main.js');

/**
 * The Next.js CLI. pnpm links a per-package node_modules, so the app-local
 * copy is correct; the workspace root is checked as a fallback for hoisted
 * installs (node-linker=hoisted).
 */
function resolveNextBin() {
  const candidates = [
    path.join(WEB_DIR, 'node_modules', 'next', 'dist', 'bin', 'next'),
    path.join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || candidates[0];
}

/**
 * The engine interpreter. The virtualenv is the only supported way to run it:
 * a global Python would resolve packages against whatever else is installed on
 * the VM, and `pip install` there needs admin rights.
 */
function resolvePythonExe() {
  const venv = isWindows
    ? path.join(ENGINE_DIR, '.venv', 'Scripts', 'python.exe')
    : path.join(ENGINE_DIR, '.venv', 'bin', 'python');
  if (fs.existsSync(venv)) return venv;

  process.stderr.write(
    `\n[brandlens] WARNING: engine virtualenv not found at ${venv}\n` +
      `[brandlens] Run infra\\windows\\setup-python.ps1 before starting brandlens-engine.\n\n`,
  );
  return venv;
}

const PYTHON_EXE = resolvePythonExe();
const NEXT_BIN = resolveNextBin();

/** Per-process log file triple, all under logs/. */
function logs(name) {
  return {
    out_file: path.join(LOG_DIR, `${name}-out.log`),
    error_file: path.join(LOG_DIR, `${name}-error.log`),
    // Merged so `pm2 logs` is readable when the worker runs multiple instances.
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS Z',
    time: false,
  };
}

/** Restart policy shared by every process. */
const restartPolicy = {
  autorestart: true,
  // Ten crashes inside `min_uptime` means a config problem, not a transient
  // fault. Backing off instead of looping forever keeps the CPU free and
  // makes the failure visible in `pm2 status` rather than buried in a log.
  max_restarts: 10,
  min_uptime: '20s',
  restart_delay: 4000,
  exp_backoff_restart_delay: 250,
  // The API finishes in-flight checks on SIGINT; give it room before SIGKILL.
  kill_timeout: 20000,
  listen_timeout: 20000,
  wait_ready: false,
  // Watch mode belongs in development, where `pnpm dev:*` provides it. A
  // service that restarts because a log file moved is a production outage.
  watch: false,
};

const WORKER_INSTANCES = Number(env('WORKER_INSTANCES', '1')) || 1;

module.exports = {
  apps: [
    /* -------------------------------------------------------------------
     * API — NestJS control plane.
     * ---------------------------------------------------------------- */
    {
      name: 'brandlens-api',
      cwd: API_DIR,
      script: API_ENTRY,
      exec_mode: 'fork',
      instances: 1,
      interpreter: 'node',
      node_args: ['--enable-source-maps'],
      env: {
        ...sharedEnv,
        API_PORT: env('API_PORT', '4000'),
        API_HOST: env('API_HOST', '127.0.0.1'),
      },
      // Nest holds the compiled ruleset cache and pg-boss client in memory;
      // 900 MB is generous headroom over a steady state of ~250 MB and low
      // enough that a leak restarts before the VM starts swapping.
      max_memory_restart: '900M',
      ...restartPolicy,
      ...logs('api'),
    },

    /* -------------------------------------------------------------------
     * Worker — pg-boss consumer.
     *
     * `instances` is separate from the API's on purpose: this is the only
     * process whose throughput scales with copies, and the right number is a
     * function of the VM's cores and of QUEUE_CONCURRENCY_*, not of anything
     * the API does. Each instance registers all twelve queues; pg-boss
     * distributes work with FOR UPDATE SKIP LOCKED, so two instances never
     * take the same job.
     * ---------------------------------------------------------------- */
    {
      name: 'brandlens-worker',
      cwd: WORKER_DIR,
      script: WORKER_ENTRY,
      exec_mode: 'fork',
      instances: WORKER_INSTANCES,
      // Gives each fork a distinct WORKER_INDEX for log correlation.
      increment_var: 'WORKER_INDEX',
      interpreter: 'node',
      node_args: ['--enable-source-maps'],
      env: {
        ...sharedEnv,
        WORKER_INDEX: 0,
      },
      // Media probing buffers whole files; the ceiling is higher than the API's.
      max_memory_restart: '1400M',
      ...restartPolicy,
      // A job can legitimately run for minutes (video probe, VLM batch).
      kill_timeout: 45000,
      ...logs('worker'),
    },

    /* -------------------------------------------------------------------
     * Web — Next.js console.
     * ---------------------------------------------------------------- */
    {
      name: 'brandlens-web',
      cwd: WEB_DIR,
      script: NEXT_BIN,
      args: ['start', '--port', String(env('WEB_PORT', '3000'))],
      exec_mode: 'fork',
      instances: 1,
      interpreter: 'node',
      env: {
        ...sharedEnv,
        PORT: env('WEB_PORT', '3000'),
        NEXT_TELEMETRY_DISABLED: '1',
        NEXT_PUBLIC_API_URL: env('NEXT_PUBLIC_API_URL', 'http://localhost:4000'),
      },
      max_memory_restart: '800M',
      ...restartPolicy,
      ...logs('web'),
    },

    /* -------------------------------------------------------------------
     * Engine — Python FastAPI.
     *
     * `interpreter: 'none'` makes `script` the executable, so this is
     * literally `<venv>\Scripts\python.exe -m uvicorn ...`.
     *
     * uvicorn runs single-worker under PM2 by design: `--workers` would fork
     * children PM2 cannot see, so a hung child would never be restarted and
     * `pm2 status` would lie about the process count. Scale the engine by
     * raising `instances` here and putting Caddy in front, not by raising
     * uvicorn's own worker count.
     * ---------------------------------------------------------------- */
    {
      name: 'brandlens-engine',
      cwd: ENGINE_DIR,
      script: PYTHON_EXE,
      interpreter: 'none',
      args: [
        '-m',
        'uvicorn',
        'brandlens_engine.main:app',
        '--host',
        env('ENGINE_HOST', '127.0.0.1'),
        '--port',
        String(env('ENGINE_PORT', '8000')),
        '--workers',
        '1',
        '--timeout-keep-alive',
        '75',
        '--no-access-log',
      ],
      exec_mode: 'fork',
      instances: 1,
      env: {
        ...sharedEnv,
        // Unbuffered, or structlog output sits in a pipe buffer and `pm2 logs`
        // shows nothing until the process exits.
        PYTHONUNBUFFERED: '1',
        PYTHONDONTWRITEBYTECODE: '1',
        // The package lives in cwd; make that explicit so PM2's cwd handling
        // does not have to be trusted.
        PYTHONPATH: ENGINE_DIR,
      },
      // scikit-image + opencv + a decoded 4K frame is the peak allocation.
      max_memory_restart: '2G',
      ...restartPolicy,
      kill_timeout: 30000,
      ...logs('engine'),
    },
  ],
};
