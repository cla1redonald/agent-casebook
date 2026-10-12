import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { repoRoot } from '../src/util/root.js';
import { EM_DASH, HOME_PATH, isExempt, loadTerms, parseTerms, scanText } from './check-terms.js';

// Made-up terms only. The real list never appears in this repository.
const MADE_UP = 'quillwort\nGrebe Lantern\n\n# a comment\n';

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('loading the deny list', () => {
  it('parses newline-separated terms, lower-cased, ignoring blanks and comments', () => {
    expect(parseTerms(MADE_UP)).toEqual(['quillwort', 'grebe lantern']);
  });

  it('prefers DENY_LIST, then falls back to .denylist, then returns nothing', () => {
    dir = mkdtempSync(join(tmpdir(), 'deny-'));
    expect(loadTerms({ DENY_LIST: 'quillwort' }, dir)).toEqual({ terms: ['quillwort'], origin: 'DENY_LIST' });
    expect(loadTerms({}, dir)).toEqual({ terms: [], origin: 'nowhere' });
    writeFileSync(join(dir, '.denylist'), MADE_UP);
    expect(loadTerms({ DENY_LIST: '  \n ' }, dir).origin).toBe('.denylist');
    expect(loadTerms({}, dir).terms).toEqual(['quillwort', 'grebe lantern']);
  });
});

describe('scanning', () => {
  it('matches case-insensitive substrings and reports line numbers', () => {
    const hits = scanText('notes.md', 'clean line\nA QUILLWORTS bed\nthe grebe lantern', parseTerms(MADE_UP));
    expect(hits).toEqual([
      { where: 'notes.md', line: 2, termIndex: 0 },
      { where: 'notes.md', line: 3, termIndex: 1 },
    ]);
  });

  it('builds the em dash and home-path checks without containing either string', () => {
    const source = readFileSync(join(repoRoot(), 'scripts', 'check-terms.ts'), 'utf8').toLowerCase();
    expect(source.includes(EM_DASH)).toBe(false);
    expect(source.includes(HOME_PATH)).toBe(false);
    expect(scanText('x', `a ${EM_DASH} b`, [EM_DASH])).toHaveLength(1);
  });

  it('exempts only the exact MIT licence line, including as a git diff line', () => {
    const licenceLine = readFileSync(join(repoRoot(), 'LICENSE'), 'utf8').split('\n')[8] ?? '';
    // A word from that line stands in for the denied term, without writing it here.
    const word = licenceLine.split(' ')[6] ?? '';
    expect(word.length).toBeGreaterThan(3);
    expect(isExempt(licenceLine)).toBe(true);
    expect(scanText('LICENSE', licenceLine, [word])).toEqual([]);
    expect(scanText('git log -p', `+${licenceLine}`, [word])).toEqual([]);
    expect(scanText('README.md', `we ${word} it`, [word])).toHaveLength(1);
    expect(scanText('LICENSE', `${licenceLine} extra`, [word])).toHaveLength(1);
  });
});
