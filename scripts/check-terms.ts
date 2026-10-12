/**
 * Fails the build if a denied term appears in the working tree or anywhere in git history.
 *
 * The terms are not in this repository. They come from the DENY_LIST environment variable
 * (newline-separated; set from a repository secret in CI) or, when that is unset or blank, from
 * a gitignored `.denylist` file in the repo root. An empty list is an error, so a missing secret
 * cannot let CI pass silently.
 *
 * Two checks are built in and need no list: the em dash character and absolute macOS home paths.
 * `--paths-only` runs just the home-path check.
 *
 * Matching is a case-insensitive substring match, the same as `grep -i`.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Built from parts so this file never contains the strings it checks for. */
export const EM_DASH = String.fromCharCode(0x2014);
export const HOME_PATH = ['', 'Users', ''].join('/').toLowerCase();

/**
 * The one exemption: the standard MIT licence line granting the right to let others use the
 * software contains a denied term, and a licence must not be reworded. Stored as the SHA-256 of
 * the trimmed, lower-cased line, so the script holds no readable or reversible form of it.
 */
const EXEMPT_LINE_SHA256 = new Set(['dafb1332c4cf1bfe3c1cc5d8f072cf7828a62b9bd6992b2a8519704048691f6b']);

export function parseTerms(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/\r?\n/)
        .map((line) => line.trim().toLowerCase())
        .filter((line) => line !== '' && !line.startsWith('#')),
    ),
  ];
}

/** DENY_LIST wins when it has content; otherwise `.denylist` in the root; otherwise nothing. */
export function loadTerms(env: NodeJS.ProcessEnv, root: string): { terms: string[]; origin: string } {
  const fromEnv = parseTerms(env['DENY_LIST'] ?? '');
  if (fromEnv.length > 0) return { terms: fromEnv, origin: 'DENY_LIST' };
  const file = join(root, '.denylist');
  if (existsSync(file)) return { terms: parseTerms(readFileSync(file, 'utf8')), origin: '.denylist' };
  return { terms: [], origin: 'nowhere' };
}

export function isExempt(line: string): boolean {
  const normalised = line.replace(/^[+-]/, '').trim().toLowerCase();
  return EXEMPT_LINE_SHA256.has(createHash('sha256').update(normalised).digest('hex'));
}

export interface Hit {
  where: string;
  line: number;
  /** Index into the term list, so CI logs never print the term itself. */
  termIndex: number;
}

export function scanText(where: string, text: string, terms: readonly string[]): Hit[] {
  const hits: Hit[] = [];
  text
    .toLowerCase()
    .split('\n')
    .forEach((line, index) => {
      const matched = terms.flatMap((term, termIndex) => (line.includes(term) ? [termIndex] : []));
      if (matched.length === 0 || isExempt(line)) return;
      for (const termIndex of matched) hits.push({ where, line: index + 1, termIndex });
    });
  return hits;
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}

function main(): void {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const pathsOnly = process.argv.includes('--paths-only');
  const builtIn = pathsOnly ? [HOME_PATH] : [EM_DASH, HOME_PATH];
  let label: string;
  let terms: string[];
  if (pathsOnly) {
    terms = builtIn;
    label = 'home-path check';
  } else {
    const loaded = loadTerms(process.env, root);
    if (loaded.terms.length === 0) {
      console.error('banned-terms check: the deny list is empty. Set DENY_LIST (CI secret) or create .denylist in the repo root.');
      process.exit(1);
    }
    terms = [...loaded.terms, ...builtIn];
    label = `banned-terms check (${loaded.terms.length} terms from ${loaded.origin}, plus em dash and home paths)`;
  }

  const hits: Hit[] = [];
  const files = git(root, ['ls-files', '-co', '--exclude-standard']).split('\n').filter(Boolean);
  for (const file of files) {
    const path = join(root, file);
    if (!existsSync(path) || !statSync(path).isFile()) continue;
    hits.push(...scanText(file, readFileSync(path, 'utf8'), terms));
  }
  let history = true;
  try {
    git(root, ['rev-parse', '--verify', 'HEAD']);
  } catch {
    history = false;
  }
  if (history) {
    hits.push(...scanText('git log (messages)', git(root, ['log', '--all', '--format=%H%n%an <%ae>%n%B']), terms));
    hits.push(...scanText('git log -p', git(root, ['log', '--all', '-p', '--format=commit %H']), terms));
  }

  if (hits.length > 0) {
    console.error(`${label}: ${hits.length} hit(s)`);
    for (const hit of hits.slice(0, 200)) console.error(`  ${hit.where}:${hit.line}: term #${hit.termIndex + 1}`);
    process.exit(1);
  }
  console.log(`${label}: clean (${files.length} files${history ? ' and full git history' : ''})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
