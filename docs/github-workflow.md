# Working with GitHub: Mac → GitHub → Windows VM

You write code on a Mac. The code lives in GitHub. The application runs on a
Windows VM. This document is the whole loop, start to finish.

---

## First, what is CI?

**CI** stands for *continuous integration*. In practice it means one thing:

> Every time you push code to GitHub, GitHub rents a clean computer, copies
> your code onto it, and runs your checks. If anything fails, it tells you.

That's it. No servers to run, nothing to install, nothing to maintain. You push
code; a few minutes later you get a green tick or a red cross next to your
commit.

The checks are the same ones you'd run by hand — typecheck, lint, tests, apply
the database migrations — except they run **every time, automatically, on a
machine with none of your local setup**. That last part matters more than it
sounds. A missing file that happens to exist on your Mac, a dependency you
installed once and forgot, an import with the wrong capitalisation — none of
these fail locally. All of them fail on the VM.

CI is where you find out. Free of charge, before your users do.

For BrandLens specifically there's a sharper reason: **you develop on macOS and
deploy to Windows.** Those two operating systems disagree about path
separators (`/` vs `\`), line endings (LF vs CRLF), and whether `Logo.png` and
`logo.png` are the same file (macOS: yes; Windows: yes; Linux: no). CI runs the
suite on both Ubuntu and Windows so those disagreements surface in a pull
request instead of at 6pm on the server.

**You do not need to configure anything.** The file `.github/workflows/ci.yml`
is already in the repository. Push it and it starts working. You watch it under
the **Actions** tab on GitHub.

### What runs, and when

| Job | Runs on | When | What it protects |
|---|---|---|---|
| **verify** | Ubuntu | every push and PR | Typecheck, lint, 90 unit tests, full build |
| **migrations** | Ubuntu + real Postgres | every push and PR | That migrations apply cleanly and the seed is idempotent |
| **engine** | Ubuntu | every push and PR | 221 Python tests, and that the engine boots without API keys |
| **windows** | **Windows** | pushes to `main` only | Path/line-ending/case bugs, PowerShell syntax, PM2 config |
| **ci-passed** | Ubuntu | always | A single tick to require before merging |

The Windows job is deliberately skipped on pull requests. Windows runners bill
at **2× the minutes** of Linux ones on private repositories, and the failures it
catches only matter immediately before a deploy — not on every intermediate
commit of a branch you're still working on.

> **Cost.** A private repo on the free plan gets 2,000 CI minutes per month.
> A full BrandLens run is roughly 6 Linux minutes plus, on `main` only, about 8
> Windows minutes billed at 2× (≈16). Call it ~22 billed minutes per merge to
> `main`, ~6 per pull-request push. That is comfortably inside the free tier for
> a small team. Public repositories are unlimited and free.

---

## One-time setup

### 1 — Create the repository and push from your Mac

```zsh
cd ~/path/to/brandlens

git init
git branch -M main
git add .
git commit -m "BrandLens initial commit"
```

Create an empty repo on github.com — **no README, no .gitignore, no licence**,
or the first push will conflict. Then:

```zsh
git remote add origin https://github.com/<you>/brandlens.git
git push -u origin main
```

Open the **Actions** tab. CI is already running.

> **Check `.env` did not get committed:** `git ls-files | grep '^\.env$'`
> should print **nothing**. It's in `.gitignore`, but confirm — it holds your
> API keys and JWT secrets. `.env.example` *is* committed, and should be: it's
> the template, with no real values in it.

### 2 — Protect `main`

Settings → Branches → Add branch protection rule:

- Branch name pattern: `main`
- ☑ Require a pull request before merging
- ☑ Require status checks to pass → search for and select **`CI passed`**
- ☑ Require branches to be up to date before merging

Now nobody — including you at 11pm — can push broken code straight to `main`.
That single checkbox is most of the value of CI.

### 3 — Set the VM up as a git clone, not a copied folder

This matters. **Do not unzip the project onto the VM.** A folder that isn't a
git clone has no history, so `deploy.ps1` cannot roll back when something
breaks.

On the Windows VM, in an elevated PowerShell:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force

git clone https://github.com/<you>/brandlens.git C:\brandlens
Set-Location C:\brandlens

.\infra\windows\bootstrap.ps1 -IncludeCaddy -InstallDependencies
Copy-Item .env.example .env
notepad .env                              # DATABASE_URL, secrets, ANTHROPIC_API_KEY

.\infra\windows\setup-database.ps1
.\infra\windows\setup-python.ps1
pnpm install --frozen-lockfile
pnpm build
.\infra\windows\install-services.ps1
.\infra\windows\healthcheck.ps1
```

**`.env` lives only on the VM.** It's gitignored, so it is never pushed, never
pulled, and never overwritten by a deploy. You write it once. If you add a new
setting to `.env.example`, you must add it to the VM's `.env` by hand —
`deploy.ps1` deliberately will not touch that file.

#### Private repo? Give the VM read-only access

Don't put your personal GitHub password on a server. Use a **deploy key** —
read-only, scoped to this one repository:

```powershell
ssh-keygen -t ed25519 -C "brandlens-vm" -f $env:USERPROFILE\.ssh\brandlens_deploy
Get-Content $env:USERPROFILE\.ssh\brandlens_deploy.pub | Set-Clipboard
```

Paste it into GitHub → your repo → Settings → Deploy keys → Add deploy key.
Leave "Allow write access" **unchecked**. Then point the clone at SSH:

```powershell
git -C C:\brandlens remote set-url origin git@github.com:<you>/brandlens.git
```

---

## Day to day

### On your Mac

```zsh
git checkout main && git pull            # start from current main

git checkout -b fix/logo-clearspace      # a branch per piece of work
# ... edit code ...

pnpm typecheck && pnpm test              # optional — CI will run these anyway

git add -A
git commit -m "Loosen logo clear space to 1.2x for square formats"
git push -u origin fix/logo-clearspace
```

GitHub prints a link to open a pull request. Open it. CI runs. When the checks
go green, merge it.

### If you changed the database schema

Anything you edit under `packages/db/src/schema/` needs a migration generated
**and committed**:

```zsh
pnpm db:generate                          # writes SQL into packages/db/drizzle/
git add packages/db/drizzle
git commit -m "Add ci_drift_probe column to users"
```

CI enforces this. The `migrations` job regenerates and fails the build if the
result differs from what you committed, with the message *"The Drizzle schema
changed but no migration was committed."*

This is not bureaucracy. The VM runs `pnpm db:migrate`, never `db:generate` —
so production applies **the exact SQL that a human reviewed in the pull
request**, rather than SQL invented on the server against live data. Read the
generated `.sql` file before committing it; `db:generate` occasionally proposes
a drop where you meant a rename.

### On the Windows VM

After merging, RDP into the VM and run one command:

```powershell
cd C:\brandlens
.\infra\windows\deploy.ps1
```

That does: pull → install (only if dependencies changed) → build → back up the
database → migrate (only if there are new migrations) → `pm2 reload` → health
check. If the health check fails, it **rolls the code back to the previous
commit automatically** and rebuilds.

Look before you leap:

```powershell
.\infra\windows\deploy.ps1 -WhatIf       # prints the plan, changes nothing
```

---

## What deploy.ps1 does, and why in that order

```
preflight → backup → pull → install → build → migrate → reload → verify
```

The ordering is the whole design: **everything that can fail should fail while
the old version is still serving traffic.**

1. **Preflight** — refuses if `.env` is missing, if the folder isn't a git
   clone, or if someone edited files directly on the server. That last one
   catches the classic "I just made one quick fix on prod" that a `git pull`
   would silently clobber.
2. **Back up** — a `pg_dump` before any migration runs. Migrations are
   **forward-only**; there is no automatic down-migration, because
   auto-reversing a dropped column is a quiet way to lose data. The backup *is*
   the rollback plan for the database.
3. **Pull** — `--ff-only`, never a merge. If the server's history has diverged
   from origin, something is wrong that a merge commit would only hide.
4. **Install & build** — the old version is still running and serving requests
   throughout. A build failure here costs you nothing.
5. **Migrate** — only when there are actually new migration files.
6. **Reload** — `pm2 reload`, not `restart`: the new process must come up
   before the old one retires, so an in-flight check isn't dropped.
7. **Verify** — polls the health endpoint for 30 seconds. On failure, rolls the
   code back and tells you plainly that the database was **not** rolled back.

Every deploy appends a line to `logs\deploy.log`.

### Useful variations

```powershell
.\infra\windows\deploy.ps1 -WhatIf                  # dry run
.\infra\windows\deploy.ps1 -Branch hotfix/urgent    # deploy a branch
.\infra\windows\deploy.ps1 -Force                   # redeploy the same commit
.\infra\windows\deploy.ps1 -NoRollback              # keep the broken build to debug it
.\infra\windows\deploy.ps1 -SkipMigrate             # code only, no schema change
```

### Rolling back on purpose

```powershell
cd C:\brandlens
git log --oneline -10                     # find the commit you want
git reset --hard <sha>
pnpm install --frozen-lockfile && pnpm build
pm2 reload all --update-env
.\infra\windows\healthcheck.ps1
```

If the version you're returning to predates a migration that has already run,
restore the matching dump from `backups\` first. See `docs/operations.md`.

---

## Line endings — the one macOS/Windows trap worth knowing about

Windows ends lines with `\r\n`; macOS and Linux use `\n`. Left alone, Git on
Windows "helpfully" converts files on checkout, and you get failures that look
like nonsense: a script reporting `\r: command not found`, or every line of
every file showing as changed in a diff with no actual edits.

`.gitattributes` in the repo root settles this: **LF everywhere in the
repository**, with CRLF only for files Windows itself opens — `.ps1`, `.bat`,
and `.env.example`, because an operator will open that one in Notepad, and
Notepad renders an LF-only file as a single unbroken line.

You don't have to do anything. Just don't delete that file, and don't set
`core.autocrlf` to override it.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| CI fails on `pnpm install --frozen-lockfile` | `package.json` changed but `pnpm-lock.yaml` wasn't committed | `pnpm install` locally, commit the lockfile |
| CI: *"schema changed but no migration was committed"* | You edited the Drizzle schema and skipped `db:generate` | `pnpm db:generate`, review the SQL, commit `packages/db/drizzle/` |
| CI green on Ubuntu, red on Windows | Path separator, line ending, or filename case | Use `path.join()`, never string-concatenate paths; check import casing matches the filename exactly |
| `deploy.ps1`: *"working tree has uncommitted changes"* | Someone edited files on the VM | Save anything worth keeping, then `git checkout -- .`, or `-Force` to discard |
| `deploy.ps1`: *"not a git clone"* | The VM was set up by unzipping | Re-provision with `git clone` — rollback needs history |
| `deploy.ps1` stops at backup | `pg_dump` can't read RLS-forced tables | See the backup section of `docs/operations.md`; `backup.ps1 -DumpUser postgres` |
| Deployed, but the app behaves as before | PM2 reloaded stale build output | `pnpm build` then `pm2 reload all --update-env` |
| App starts, then dies immediately | A new setting exists in `.env.example` but not in the VM's `.env` | Diff them and add the missing keys |
| `git pull` on the VM asks for a password | HTTPS remote on a private repo | Set up a deploy key (above) and switch the remote to SSH |

---

## If you later want deploys to happen automatically

Right now deploying is a deliberate act: you RDP in and run one command. That
is a reasonable choice for a single production VM, and it means nothing ships
while you're not looking.

When that becomes tedious, the next step is a **self-hosted GitHub Actions
runner** — a small service on the VM that watches the repository and runs
`deploy.ps1` itself whenever `main` changes. Every deploy then gets a full log
in the Actions tab, and nobody needs to remember.

Two things to have in place first: CI you actually trust (because it becomes
the only gate), and a staging VM (because the first automated deploy that
breaks production is an expensive way to learn). Until both are true, the
manual command is the safer trade.
