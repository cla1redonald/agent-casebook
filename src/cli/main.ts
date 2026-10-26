import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DETECTORS, implemented } from '../../library/detectors/index.js';
import { loadCorpus, scoreDetector } from '../../library/scoring.js';
import type { Finding } from '../../library/types.js';
import { AccusationError, judge, MIN_GROUPS, MIN_PRECISION, type Accusation } from '../cases/accuse.js';
import { AREAS, findCase, listCases, loadSuspectPool } from '../cases/load.js';
import { readState, statePath, writeState } from '../cases/state.js';
import { readTrace, TraceParseError } from '../trace/read.js';
import { repoRoot } from '../util/root.js';

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

const USAGE = `casebook: ten broken AI agents, and the evidence of who did it

  casebook list                         the ten cases, their areas and your progress
  casebook open <case>                  the scene, witnesses, evidence locker and line-up
  casebook accuse <case> --suspect <id> --cite ev-014,ev-022 --test "<cheapest test that would prove you wrong>"
  casebook sweep <dir>                  run every detector over your own .jsonl traces
  casebook detectors                    the detector library, with true and false positive counts

<case> can be 3, 03 or 03-the-quiet-understudy.`;

interface Parsed {
  positional: string[];
  flags: Map<string, string>;
}

function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split('=', 2) as [string, string | undefined];
      const next = argv[i + 1];
      if (inline !== undefined) flags.set(name, inline);
      else if (next !== undefined && !next.startsWith('--')) {
        flags.set(name, next);
        i++;
      } else flags.set(name, 'true');
    } else positional.push(arg);
  }
  return { positional, flags };
}

export async function main(argv: string[], io: Io, root = repoRoot()): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const [command, ...rest] = positional;
  try {
    switch (command) {
      case 'list':
        return list(root, io);
      case 'open':
        return open(root, rest[0], io);
      case 'accuse':
        return accuse(root, rest[0], flags, io);
      case 'sweep':
        return sweep(rest[0], flags.has('json'), io);
      case 'detectors':
        return detectors(root, io);
      case undefined:
      case 'help':
        io.out(USAGE);
        return 0;
      default:
        io.err(`Unknown command "${command}".\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof AccusationError || error instanceof TraceParseError || error instanceof Error) {
      io.err(error.message);
      return 1;
    }
    throw error;
  }
}

function list(root: string, io: Io): number {
  const state = readState(statePath(root));
  io.out('No  Title                          Organisation                                 Recording   Progress');
  for (const { file } of listCases(root)) {
    const progress = state.cases[file.id];
    const status = progress?.solved ? `solved (attempt ${progress.solvedOnAttempt})` : progress ? `${progress.attempts} attempt(s)` : '';
    const recording = file.status === 'recorded' ? `${file.recording} trace` : 'pending';
    io.out(`${String(file.number).padStart(2, '0')}  ${file.title.padEnd(30)} ${file.organisation.padEnd(44)} ${recording.padEnd(11)} ${status}`);
    io.out(`    areas: ${file.areas.map((area) => AREAS[area]).join('; ')}`);
  }
  return 0;
}

function open(root: string, reference: string | undefined, io: Io): number {
  if (!reference) throw new AccusationError('Which case? For example: casebook open 3');
  const loaded = findCase(root, reference);
  const pool = loadSuspectPool(root);
  io.out(readFileSync(join(loaded.dir, 'README.md'), 'utf8').trimEnd());
  io.out('');
  io.out('Line-up ids for --suspect:');
  for (const id of loaded.file.suspects) io.out(`  ${id.padEnd(22)} ${pool.get(id)?.name ?? '(not in the shared pool)'}`);
  io.out('');
  io.out(
    loaded.tracePath
      ? `Trace: ${relative(root, loaded.tracePath)} (${loaded.file.recording} recording). Accuse with:\n  casebook accuse ${loaded.file.number} --suspect <id> --cite ev-...,ev-... --test "..."`
      : 'This case has no recording yet. The case README above says why.',
  );
  return 0;
}

function accuse(root: string, reference: string | undefined, flags: Map<string, string>, io: Io): number {
  if (!reference) throw new AccusationError('Which case? For example: casebook accuse 3 --suspect <id> --cite ev-014 --test "..."');
  const loaded = findCase(root, reference);
  const accusation: Accusation = {
    suspect: (flags.get('suspect') ?? '').trim(),
    cite: (flags.get('cite') ?? '').split(',').filter((id) => id.trim() !== ''),
    test: flags.get('test') ?? '',
  };
  const judgement = judge(loaded, accusation);

  const path = statePath(root);
  const state = readState(path);
  const progress = state.cases[loaded.file.id] ?? { attempts: 0, solved: false };
  progress.attempts += 1;
  if (judgement.outcome === 'solved' && !progress.solved) {
    progress.solved = true;
    progress.solvedOnAttempt = progress.attempts;
  }
  state.cases[loaded.file.id] = progress;
  writeState(path, state);

  io.out(`${loaded.file.title}: attempt ${progress.attempts}.`);
  if (judgement.unknownCitations.length > 0) io.out(`Not in the trace: ${judgement.unknownCitations.join(', ')}.`);
  switch (judgement.outcome) {
    case 'wrong-suspect':
      io.out(`Not ${accusation.suspect}. The evidence does not support it. Citations are only scored against the right suspect.`);
      return 1;
    case 'red-herring':
      io.out(`Not ${accusation.suspect}. That is the red herring. It did happen and it is in the trace, but it did not cause this.`);
      return 1;
    case 'weak-citations':
      io.out(
        `Right suspect, but the citations do not carry it yet. They have precision ${judgement.precision?.toFixed(2)}, ` +
          `evidence groups covered ${judgement.groupsHit} of ${judgement.groupsTotal} (recall ${judgement.recall?.toFixed(2)}).`,
      );
      io.out(`To unseal the solution, cite at least ${MIN_GROUPS} groups with precision of ${MIN_PRECISION} or better.`);
      return 1;
    case 'solved': {
      io.out(
        `Solved. Precision ${judgement.precision?.toFixed(2)}, evidence groups covered ${judgement.groupsHit} of ${judgement.groupsTotal} (recall ${judgement.recall?.toFixed(2)}).`,
      );
      io.out(`Your falsification test: ${accusation.test}`);
      io.out(`The casebook's cheapest test: ${judgement.solution?.front.cheapest_test}`);
      io.out('');
      io.out(judgement.solution?.body ?? '');
      return 0;
    }
  }
}

function collectJsonl(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'node_modules' && name !== 'locker' && !name.startsWith('.')) found.push(...collectJsonl(path));
    } else if (name.endsWith('.jsonl')) found.push(path);
  }
  return found;
}

function sweep(dir: string | undefined, asJson: boolean, io: Io): number {
  if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) throw new AccusationError('Give a directory of .jsonl traces: casebook sweep ./traces');
  const files = collectJsonl(dir);
  if (files.length === 0) {
    io.err(`No .jsonl files under ${dir}.`);
    return 2;
  }
  const library = implemented();
  const results: Array<{ file: string; findings: Finding[]; error?: string }> = [];
  for (const file of files) {
    try {
      const { events } = readTrace(file);
      results.push({ file: relative(dir, file), findings: library.flatMap((detector) => detector.detect(events)) });
    } catch (error) {
      results.push({ file: relative(dir, file), findings: [], error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (asJson) {
    io.out(JSON.stringify(results, null, 2));
    return 0;
  }
  let total = 0;
  for (const result of results) {
    if (result.error) {
      io.out(`${result.file}: skipped, ${result.error}`);
      continue;
    }
    if (result.findings.length === 0) {
      io.out(`${result.file}: no findings`);
      continue;
    }
    total += result.findings.length;
    io.out(`${result.file}: ${result.findings.length} finding(s)`);
    const shown = result.findings.slice(0, 5);
    for (const finding of shown) io.out(`  [${finding.detector} ${finding.severity}] ${finding.ev.join(', ')}: ${finding.message}`);
    if (result.findings.length > shown.length) io.out(`  ... and ${result.findings.length - shown.length} more (use --json for all)`);
  }
  io.out('');
  io.out(`${total} finding(s) across ${results.length} file(s), from ${library.length} implemented detector(s) of ${DETECTORS.length}.`);
  return 0;
}

function detectors(root: string, io: Io): number {
  const corpus = loadCorpus(root);
  io.out('Detector library. TP: faulted sessions caught on its own case trace. FP on control: control traces with any finding, then sessions.');
  io.out('');
  io.out('id   title                  case                          status        TP on case   FP on control');
  const scores = DETECTORS.map((detector) => ({ detector, score: scoreDetector(detector, corpus) }));
  for (const { detector, score } of scores) {
    const controlSessions = corpus.filter((file) => file.kind === 'control').reduce((sum, file) => sum + file.sessions.size, 0);
    const controlFlagged = corpus
      .filter((file) => file.kind === 'control')
      .reduce((sum, file) => sum + new Set(detector.detect(file.events).flatMap((finding) => finding.trace_ids)).size, 0);
    const tp = score.recorded ? `${score.truePositives}/${score.positives}` : 'pending';
    const fp = detector.meta.status === 'implemented' ? `${score.controlFilesWithFindings}/${score.controlFiles} files, ${controlFlagged}/${controlSessions} sessions` : 'pending';
    io.out(`${detector.meta.id}  ${detector.meta.title.padEnd(22)} ${detector.meta.case.padEnd(29)} ${detector.meta.status.padEnd(13)} ${tp.padEnd(12)} ${fp}`);
  }
  io.out('');
  io.out('Known blind spots:');
  for (const { detector } of scores) {
    io.out(`  ${detector.meta.id} ${detector.meta.title}: ${detector.meta.rule}`);
    for (const blind of detector.meta.blindSpots) io.out(`      - ${blind}`);
  }
  return 0;
}
