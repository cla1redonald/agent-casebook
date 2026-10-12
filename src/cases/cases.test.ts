import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readTrace } from '../trace/read.js';
import { repoRoot } from '../util/root.js';
import { findCase, listCases, loadSuspectPool } from './load.js';
import { redHerringHash, seal, unseal, verdictHash } from './seal.js';
import { splitSolution } from './solution.js';

const root = repoRoot();
const cases = listCases(root);
const pool = loadSuspectPool(root);

describe('the casebook', () => {
  it('has ten cases numbered 1 to 10, titled "The ..."', () => {
    expect(cases.map((c) => c.file.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const { file } of cases) expect(file.title).toMatch(/^The [A-Z]/);
  });

  it('records nine cases live and leaves case 2, which did not reproduce, pending', () => {
    expect(cases.filter((c) => c.file.status === 'recorded').map((c) => c.file.number)).toEqual([1, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const c of cases.filter((candidate) => candidate.file.status === 'recorded')) expect(c.file.recording).toBe('live');
    for (const c of cases) expect(c.tracePath !== null).toBe(c.file.status === 'recorded');
  });

  it('covers every area at least once', () => {
    const covered = new Set(cases.flatMap((c) => c.file.areas));
    expect(covered.size).toBe(7);
  });

  it('draws every line-up of six from the shared pool, with no repeats', () => {
    for (const { file } of cases) {
      expect(new Set(file.suspects).size).toBe(6);
      for (const id of file.suspects) expect(pool.has(id), `${file.id}: ${id}`).toBe(true);
    }
  });

  it('shows the same line-up in the README as in case.yaml', () => {
    for (const { file, dir } of cases) {
      const readme = readFileSync(join(dir, 'README.md'), 'utf8');
      const ids = [...readme.matchAll(/^\| `([a-z-]+)` \|/gm)].map((match) => match[1]);
      expect(ids, file.id).toEqual(file.suspects);
    }
  });

  it.each(cases.map((c) => [c.file.id, c] as const))('%s: exactly one suspect unseals the solution and it matches the verdict hash', (_id, loaded) => {
    const sealed = readFileSync(loaded.sealedPath, 'utf8');
    const opened = loaded.file.suspects.filter((suspect) => unseal(sealed, suspect, loaded.file.id) !== null);
    expect(opened).toHaveLength(1);
    const [suspect] = opened as [string];
    expect(verdictHash(loaded.file.id, suspect)).toBe(loaded.file.verdict.sha256);
    const { front } = splitSolution(unseal(sealed, suspect, loaded.file.id) as string);
    expect(front.case).toBe(loaded.file.id);
    expect(front.suspect).toBe(suspect);
    // The red herring is a different suspect in the same line-up.
    const herrings = loaded.file.suspects.filter((id) => redHerringHash(loaded.file.id, id) === loaded.file.red_herring.sha256);
    expect(herrings).toEqual([front.red_herring]);
    expect(front.red_herring).not.toBe(suspect);
    expect(front.cracking.length).toBeGreaterThanOrEqual(2);
    // Recorded cases cite ids that exist in the trace; pending ones describe what is planned.
    if (loaded.tracePath) {
      const known = new Set(readTrace(loaded.tracePath).events.map((event) => event.ev));
      for (const group of front.cracking) {
        expect(group.ev.length, group.label).toBeGreaterThan(0);
        for (const ev of group.ev) expect(known.has(ev), ev).toBe(true);
      }
    } else {
      for (const group of front.cracking) expect(group.planned, group.label).toBeTruthy();
    }
  });

  it('finds cases by number, padded number, id or slug', () => {
    expect(findCase(root, '3').file.id).toBe('03-the-quiet-understudy');
    expect(findCase(root, '03').file.id).toBe('03-the-quiet-understudy');
    expect(findCase(root, '10').file.id).toBe('10-the-willing-hand');
    expect(findCase(root, 'the-marked-paper').file.number).toBe(6);
    expect(() => findCase(root, '11')).toThrow(/No case matches/);
  });
});

describe('sealing', () => {
  it('round-trips with the right suspect and refuses the wrong one', () => {
    const sealed = seal('---\nsecret\n', 'the-butler', '99-the-test');
    expect(unseal(sealed, 'the-butler', '99-the-test')).toBe('---\nsecret\n');
    expect(unseal(sealed, 'the-gardener', '99-the-test')).toBeNull();
    expect(unseal(sealed, 'the-butler', '98-the-test')).toBeNull();
  });

  it('writes only hex after the header, so a sealed file cannot contain words by chance', () => {
    const sealed = seal('A long solution. '.repeat(50), 'a', 'b');
    const body = sealed.split('\n').slice(1).join('\n');
    expect(body.replace(/^(salt|iv|tag) /gm, '').replace(/^data$/m, '')).toMatch(/^[0-9a-f\n]*$/);
  });
});
