import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { redHerringHash, seal, verdictHash } from '../cases/seal.js';
import { repoRoot } from '../util/root.js';
import { main } from './main.js';

/**
 * Tests run against a fixture case in a temporary copy of the casebook, so they never
 * name the real answer to a real case.
 */
const FIXTURE_ID = '99-the-test-fixture';
const RIGHT = 'fallback-path';
const HERRING = 'prompt-change';

let root: string;
let output: string[];
let errors: string[];
const io = { out: (line: string) => output.push(line), err: (line: string) => errors.push(line) };
const run = async (...argv: string[]) => main(argv, io, root);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'whodunnit-'));
  const real = repoRoot();
  cpSync(join(real, 'cases'), join(root, 'cases'), { recursive: true });
  cpSync(join(real, 'corpus'), join(root, 'corpus'), { recursive: true });
  cpSync(join(real, 'evals', 'labels'), join(root, 'evals', 'labels'), { recursive: true });
  process.env.WHODUNNIT_STATE = join(root, 'state.json');

  const dir = join(root, 'cases', FIXTURE_ID);
  cpSync(join(real, 'cases', '03-the-quiet-understudy'), dir, { recursive: true });
  const yaml = readFileSync(join(dir, 'case.yaml'), 'utf8')
    .replace(/^id: .*$/m, `id: ${FIXTURE_ID}`)
    .replace(/^number: .*$/m, 'number: 99')
    .replace(/^title: .*$/m, 'title: The Test Fixture')
    .replace(/(red_herring:\n\s+sha256: )\S+/, `$1${redHerringHash(FIXTURE_ID, HERRING)}`)
    .replace(/(verdict:\n\s+sha256: )\S+/, `$1${verdictHash(FIXTURE_ID, RIGHT)}`);
  writeFileSync(join(dir, 'case.yaml'), yaml);
  const front = {
    case: FIXTURE_ID,
    suspect: RIGHT,
    red_herring: HERRING,
    cracking: [
      { label: 'group a', ev: ['ev-010', 'ev-011'] },
      { label: 'group b', ev: ['ev-020'] },
      { label: 'group c', ev: ['ev-030'] },
    ],
    cheapest_test: 'The fixture test.',
  };
  writeFileSync(join(dir, 'sealed', 'solution.md.enc'), seal(`---\n${stringify(front)}---\n\nFixture solution body.\n`, RIGHT, FIXTURE_ID));
  output = [];
  errors = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.WHODUNNIT_STATE;
});

const TEST = '--test=Restore the key and look at the source attribute';

describe('whodunnit accuse', () => {
  it('names a wrong suspect without scoring citations', async () => {
    expect(await run('accuse', '99', '--suspect', 'model-update', '--cite', 'ev-010', TEST)).toBe(1);
    expect(output.join('\n')).toMatch(/Not model-update/);
    expect(output.join('\n')).not.toMatch(/precision/);
  });

  it('calls out the red herring', async () => {
    await run('accuse', '99', '--suspect', HERRING, '--cite', 'ev-010', TEST);
    expect(output.join('\n')).toMatch(/That is the red herring/);
  });

  it('scores precision and recall for the right suspect and keeps the solution sealed when citations are weak', async () => {
    expect(await run('accuse', '99', '--suspect', RIGHT, '--cite', 'ev-010,ev-001,ev-002', TEST)).toBe(1);
    const text = output.join('\n');
    expect(text).toMatch(/Right suspect/);
    expect(text).toMatch(/precision 0\.33, evidence groups covered 1 of 3 \(recall 0\.33\)/);
    expect(text).not.toMatch(/Fixture solution body/);
  });

  it('unseals the solution on a correct accusation and counts attempts', async () => {
    await run('accuse', '99', '--suspect', 'model-update', '--cite', 'ev-010', TEST);
    expect(await run('accuse', '99', '--suspect', RIGHT, '--cite', 'ev-010,ev-020', TEST)).toBe(0);
    const text = output.join('\n');
    expect(text).toMatch(/attempt 2/);
    expect(text).toMatch(/Solved. Precision 1\.00, evidence groups covered 2 of 3/);
    expect(text).toMatch(/Fixture solution body/);
    expect(text).toMatch(/The fixture test\./);
    const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
    expect(state.cases[FIXTURE_ID]).toEqual({ attempts: 2, solved: true, solvedOnAttempt: 2 });
    output = [];
    await run('list');
    expect(output.join('\n')).toMatch(/The Test Fixture.*solved \(attempt 2\)/);
  });

  it('flags citations that are not in the trace', async () => {
    await run('accuse', '99', '--suspect', RIGHT, '--cite', 'ev-010,ev-020,ev-9999', TEST);
    expect(output.join('\n')).toMatch(/Not in the trace: ev-9999/);
  });

  it('rejects malformed accusations without counting an attempt', async () => {
    expect(await run('accuse', '99', '--suspect', 'the-butler', '--cite', 'ev-010', TEST)).toBe(1);
    expect(errors.join('\n')).toMatch(/not in this line-up/);
    expect(await run('accuse', '99', '--suspect', RIGHT, '--cite', 'ev-010', '--test', 'short')).toBe(1);
    expect(errors.join('\n')).toMatch(/cheapest test/);
    expect(await run('accuse', '99', '--suspect', RIGHT, TEST)).toBe(1);
    expect(errors.join('\n')).toMatch(/Cite at least one/);
    expect(await run('accuse', '2', '--suspect', 'send-gate', '--cite', 'ev-001', TEST)).toBe(1);
    expect(errors.join('\n')).toMatch(/no recording yet/);
    output = [];
    await run('list');
    expect(output.join('\n')).not.toMatch(/attempt/);
  });
});

describe('whodunnit list, open, sweep, detectors', () => {
  it('lists the ten cases plus the fixture with their areas', async () => {
    expect(await run('list')).toBe(0);
    const text = output.join('\n');
    expect(text).toMatch(/03 {2}The Quiet Understudy/);
    expect(text).toMatch(/02 {2}The Helpful Footnote .*pending/);
    expect(text).toMatch(/10 {2}The Willing Hand .*live trace/);
    expect(text).toMatch(/areas: Evals, testing and observability; AI SDLC/);
  });

  it('opens a case with its scene and line-up', async () => {
    expect(await run('open', '6')).toBe(0);
    const text = output.join('\n');
    expect(text).toMatch(/# The Marked Paper/);
    expect(text).toMatch(/## The scene/);
    expect(text).toMatch(/eval-harness {10,}The eval harness/);
  });

  it('opens a pending case and says it has no recording', async () => {
    await run('open', '2');
    expect(output.join('\n')).toMatch(/no recording yet/);
  });

  it('sweeps a directory of traces and reports findings per file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sweep-'));
    cpSync(join(root, 'cases', '03-the-quiet-understudy', 'trace.jsonl'), join(dir, 'mine.jsonl'));
    cpSync(join(root, 'corpus', 'control', 'c01-ferry-live.jsonl'), join(dir, 'clean.jsonl'));
    writeFileSync(join(dir, 'broken.jsonl'), '{not json\n');
    expect(await run('sweep', dir)).toBe(0);
    const text = output.join('\n');
    expect(text).toMatch(/mine.jsonl: 58 finding\(s\)/);
    expect(text).toMatch(/clean.jsonl: no findings/);
    expect(text).toMatch(/broken.jsonl: skipped, .*not valid JSON/);
    output = [];
    await run('sweep', dir, '--json');
    expect(JSON.parse(output.join('\n'))).toHaveLength(3);
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to sweep something that is not a directory', async () => {
    expect(await run('sweep', join(root, 'nope'))).toBe(1);
  });

  it('prints the detector table with blind spots', async () => {
    expect(await run('detectors')).toBe(0);
    const text = output.join('\n');
    expect(text).toMatch(/d03 {2}Silent fallback .*implemented {3}58\/58 {8}0\/10 files, 0\/89 sessions/);
    expect(text).toMatch(/d02 {2}Unconfirmed send .*skeleton {6}pending/);
    expect(text).toMatch(/d01 {2}Dropped constraint .*implemented {3}1\/1/);
    expect(text).toMatch(/Known blind spots/);
  });

  it('prints usage for no command and fails on an unknown one', async () => {
    expect(await run()).toBe(0);
    expect(output.join('\n')).toMatch(/whodunnit sweep <dir>/);
    expect(await run('confess')).toBe(2);
  });
});
