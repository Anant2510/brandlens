import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * An architectural test, not a behavioural one.
 *
 * `lib: ["ES2022", "DOM"]` is enabled in the worker's tsconfig so the function
 * Playwright runs inside the page can be typechecked. The side effect is that
 * `document`, `window` and friends now typecheck in every worker file — where
 * they are undefined at runtime. That turns a compile error into a 3am
 * `ReferenceError: document is not defined` inside a queue handler.
 *
 * This test is the fence around that. It fails the build if a DOM global
 * appears anywhere in the worker except the one file that legitimately runs in
 * a browser. If you are here because this failed: you probably meant to put
 * that code inside `page.evaluate`.
 */

const WORKER_SRC = resolve(__dirname, '..', '..');

/** The only file whose code is shipped into a page and executed there. */
const BROWSER_CONTEXT_FILES = new Set([join('services', 'discovery', 'browser.ts')]);

const DOM_GLOBALS = [
  'document',
  'window',
  'getComputedStyle',
  'localStorage',
  'sessionStorage',
  'navigator',
  'HTMLElement',
  'DOMRect',
  'CSSStyleDeclaration',
];

// Word-boundary match that skips `foo.document` and `'document'` inside a
// string, so a comment mentioning the word does not fail the build.
const PATTERN = new RegExp(String.raw`(?<![.'"\w])(${DOM_GLOBALS.join('|')})\b`);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

describe('worker source must not use DOM globals', () => {
  const files = walk(WORKER_SRC);

  it('finds worker source files to check', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files.map((f) => relative(WORKER_SRC, f)))('%s uses no DOM globals', (relPath) => {
    if (BROWSER_CONTEXT_FILES.has(relPath.split('/').join(sep))) return;

    const code = stripCommentsAndStrings(readFileSync(join(WORKER_SRC, relPath), 'utf8'));
    const offenders = code
      .split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => PATTERN.test(line));

    expect(
      offenders,
      `${relPath} references a DOM global. The worker is a Node process — ` +
        'this would be undefined at runtime. Move it inside page.evaluate().',
    ).toEqual([]);
  });
});
