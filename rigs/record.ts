/**
 * Records and renders every trace.
 *
 *   npm run record                          render every trace from stub scripts and live cassettes (no network)
 *   npm run record -- --check               exit 1 if any committed file differs from a fresh render
 *   npm run record -- --live 03,06 --dry-run   print the planned calls and token estimate, spend nothing
 *   npm run record -- --live 03 --take 1    record a live take (needs ANTHROPIC_API_KEY), then render
 *
 * A case whose incident and fixed cassettes both exist under recordings/live/ is rendered from
 * them as a live recording; its stub recording moves to recordings/stub/ for reference. A case
 * with no cassettes stays a stub recording in place. Control traces work the same way, one by one.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TraceEvent } from '../src/trace/schema.js';
import { CRACKING } from './cracking.js';
import { repoRoot } from '../src/util/root.js';
import { HOME_PATH, loadTerms } from '../scripts/check-terms.js';
import { AnthropicMessagesClient } from './anthropic.js';
import type { MessagesRequest, MessagesResponse } from './client.js';
import { HARD_STOP_USD, Ledger, LedgeredClient } from './ledger.js';
import { CASSETTE_FORMAT, readCassette, Redactor, writeCassette, type Cassette, type CassetteEntry } from './live.js';
import { costUsd, rateCard } from './pricing.js';
import { LIVE_MODEL, RIG_VERSION, toJsonl, type Recording, type RecordingMode } from './scenario.js';
import { CASE_ID as CASE_01, recordCase01 } from './scenarios/case01-long-afternoon.js';
import { CASE_ID as CASE_02, recordCase02 } from './scenarios/case02-helpful-footnote.js';
import { CASE_ID as CASE_03, recordCase03 } from './scenarios/case03-quiet-understudy.js';
import { CASE_ID as CASE_04, recordCase04 } from './scenarios/case04-eleven-thousand-knocks.js';
import { CASE_ID as CASE_05, recordCase05 } from './scenarios/case05-altered-figure.js';
import { CASE_ID as CASE_07, recordCase07 } from './scenarios/case07-wrong-door.js';
import { CASE_ID as CASE_08, recordCase08 } from './scenarios/case08-lapsed-policy.js';
import { CASE_ID as CASE_09, recordCase09 } from './scenarios/case09-empty-cabinet.js';
import { CASE_ID as CASE_10, recordCase10 } from './scenarios/case10-willing-hand.js';
import { CASE_ID as CASE_06, recordCase06 } from './scenarios/case06-marked-paper.js';
import { CONTROL_TRACES } from './scenarios/control.js';
import { estimateTokens } from './stub.js';

export { CRACKING, type CrackingGroup } from './cracking.js';

type Variant = 'incident' | 'fixed' | 'control';

/** One trace file the rig can produce, in stub, live or replay mode. */
export interface RecordingSpec {
  /** Scales the dry-run estimate for scenarios with no stub script, whose stub run makes one call per session. */
  plannedCallsPerSession?: number;
  /** Where the cassette lives, relative to recordings/live. */
  cassette: string;
  caseId: string;
  variant: Variant;
  record: (mode: RecordingMode) => Promise<Recording>;
}

export interface Target {
  /** Case folder id, or "control". */
  id: string;
  /** False for the Phase 3b cases, which have no stub script and render only from cassettes. */
  hasStub: boolean;
  recordings: RecordingSpec[];
}

function caseTarget(id: string, record: (variant: 'incident' | 'fixed', mode: RecordingMode) => Promise<Recording>, options: { hasStub: boolean; plannedCallsPerSession?: number }): Target {
  return {
    id,
    hasStub: options.hasStub,
    recordings: (['incident', 'fixed'] as const).map((variant) => ({
      cassette: join(id, `${variant}.cassette.jsonl`),
      caseId: id,
      variant,
      record: (mode) => record(variant, mode),
      ...(options.plannedCallsPerSession ? { plannedCallsPerSession: options.plannedCallsPerSession } : {}),
    })),
  };
}

export const TARGETS: Target[] = [
  caseTarget(CASE_01, recordCase01, { hasStub: false, plannedCallsPerSession: 2 }),
  caseTarget(CASE_02, recordCase02, { hasStub: false, plannedCallsPerSession: 4 }),
  caseTarget(CASE_03, recordCase03, { hasStub: true }),
  caseTarget(CASE_06, recordCase06, { hasStub: true }),
  caseTarget(CASE_04, recordCase04, { hasStub: false }),
  caseTarget(CASE_05, recordCase05, { hasStub: false, plannedCallsPerSession: 3 }),
  caseTarget(CASE_07, recordCase07, { hasStub: false, plannedCallsPerSession: 2.5 }),
  caseTarget(CASE_08, recordCase08, { hasStub: false, plannedCallsPerSession: 2 }),
  caseTarget(CASE_09, recordCase09, { hasStub: false, plannedCallsPerSession: 2.5 }),
  caseTarget(CASE_10, recordCase10, { hasStub: false, plannedCallsPerSession: 3 }),
  {
    id: 'control',
    hasStub: true,
    recordings: CONTROL_TRACES.map((control) => ({ cassette: join('control', `${control.name}.cassette.jsonl`), caseId: `control/${control.name}`, variant: 'control' as const, record: control.record })),
  },
];

/** Accepts "03", "3", a case id, "control" or "all". */
export function resolveTargets(list: string): Target[] {
  const wanted = list.split(',').map((item) => item.trim()).filter(Boolean);
  if (wanted.includes('all')) return TARGETS;
  return wanted.map((item) => {
    const found = TARGETS.find((target) => target.id === item || (item !== 'control' && target.id.startsWith(`${item.padStart(2, '0')}-`)));
    if (!found) throw new Error(`No recordable target "${item}". Known: ${TARGETS.map((target) => target.id).join(', ')}.`);
    return found;
  });
}

export interface OutputFile {
  path: string;
  content: string;
}

function lockerFiles(dir: string, recordings: Recording[], indexFor?: Recording): OutputFile[] {
  const files: OutputFile[] = [];
  const blobs = new Map<string, string>();
  for (const recording of recordings) for (const [hash, text] of recording.blobs) blobs.set(hash, text);
  for (const [hash, text] of [...blobs].sort(([a], [b]) => a.localeCompare(b))) {
    let pretty = text;
    try {
      pretty = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      // Not JSON: stored as text.
    }
    files.push({ path: join(dir, `${hash}.json`), content: `${pretty}\n` });
  }
  if (indexFor) {
    const lines = [
      '# Evidence locker index',
      '',
      'Tool outputs longer than 400 characters are stored here by SHA-256 of their exact text (the file is that text, pretty-printed).',
      'Each row lists the events in `trace.jsonl` that reference the blob.',
      '',
      '| Blob | Referenced by | Span |',
      '|---|---|---|',
    ];
    const references = new Map<string, TraceEvent[]>();
    for (const event of indexFor.events) {
      if (!event.locker) continue;
      const hash = event.locker.slice('sha256:'.length);
      references.set(hash, [...(references.get(hash) ?? []), event]);
    }
    for (const [hash, events] of [...references].sort((a, b) => (a[1][0]?.ev ?? '').localeCompare(b[1][0]?.ev ?? ''))) {
      lines.push(`| \`${hash.slice(0, 12)}\` | ${events.map((event) => event.ev).join(', ')} | ${events[0]?.name ?? ''} |`);
    }
    if (references.size > 0) files.push({ path: join(dir, 'INDEX.md'), content: `${lines.join('\n')}\n` });
  }
  return files;
}

export function cassettePath(root: string, spec: RecordingSpec): string {
  return join(root, 'recordings', 'live', spec.cassette);
}

/** Replays a cassette through the rig. Throws if the rig's requests differ from the recorded ones. */
async function replay(spec: RecordingSpec, cassette: Cassette): Promise<Recording> {
  const progress = { calls: 0 };
  const recording = await spec.record({ kind: 'replay', cassette, progress });
  if (progress.calls !== cassette.entries.length) throw new Error(`${spec.cassette}: the rig made fewer calls than the cassette holds. Re-record this take.`);
  return recording;
}

const STUB_README = `# Stub recordings (reference only)

STUB RECORDINGS. Every model response under this folder was produced by a deterministic script in \`rigs/scenarios\`, not by a live model, and every timing comes from a simulated clock. They are the Phase 3a recordings of the traces that have since been recorded live. They are kept so the scripted and the live behaviour can be compared, and \`npm run record -- --check\` still reproduces them byte for byte.

They are not part of the casebook or the evals. The cases and the control corpus read their live recordings.
`;

/** Produces every file the recorder owns, without touching the disk or the network. */
export async function renderAll(root: string): Promise<{ files: OutputFile[]; authoring: OutputFile[] }> {
  const files: OutputFile[] = [];
  const authoring: OutputFile[] = [];
  const stubRoot = join(root, 'recordings', 'stub');
  let anyStubMoved = false;

  for (const target of TARGETS.filter((candidate) => candidate.id !== 'control')) {
    const [incidentSpec, fixedSpec] = target.recordings as [RecordingSpec, RecordingSpec];
    const cassettes = [readCassette(cassettePath(root, incidentSpec)), readCassette(cassettePath(root, fixedSpec))];
    if ((cassettes[0] === null) !== (cassettes[1] === null)) throw new Error(`${target.id}: record both the incident and the fixed take before rendering.`);
    const live = cassettes[0] !== null && cassettes[1] !== null;
    // A case with no stub script and no cassettes is still pending: nothing to render.
    if (!live && !target.hasStub) continue;
    const stubIncident = target.hasStub ? await incidentSpec.record({ kind: 'stub' }) : null;
    const stubFixed = target.hasStub ? await fixedSpec.record({ kind: 'stub' }) : null;
    const incident = live ? await replay(incidentSpec, cassettes[0] as Cassette) : (stubIncident as Recording);
    const fixed = live ? await replay(fixedSpec, cassettes[1] as Cassette) : (stubFixed as Recording);

    const dir = join(root, 'cases', target.id);
    files.push({ path: join(dir, 'trace.jsonl'), content: toJsonl(incident) });
    files.push({ path: join(dir, 'sealed', 'trace.fixed.jsonl'), content: toJsonl(fixed) });
    files.push(...lockerFiles(join(dir, 'locker'), [incident, fixed], incident));
    files.push({
      path: join(root, 'evals', 'labels', `${target.id}.json`),
      content: `${JSON.stringify({ case: target.id, recording: live ? 'live' : 'stub', faulted_trace_ids: incident.faultedTraceIds }, null, 2)}\n`,
    });
    const crack = CRACKING[target.id];
    if (crack) authoring.push({ path: join(root, 'authoring', 'cracking', `${target.id}.json`), content: `${JSON.stringify(crack(incident.events, incident.blobs), null, 2)}\n` });

    if (live && stubIncident && stubFixed) {
      anyStubMoved = true;
      const stubDir = join(stubRoot, 'cases', target.id);
      files.push({ path: join(stubDir, 'trace.jsonl'), content: toJsonl(stubIncident) });
      files.push({ path: join(stubDir, 'trace.fixed.jsonl'), content: toJsonl(stubFixed) });
      files.push(...lockerFiles(join(stubDir, 'locker'), [stubIncident, stubFixed]));
    }
  }

  const controlTarget = TARGETS.find((target) => target.id === 'control');
  const controlDir = join(root, 'corpus', 'control');
  const placed: Recording[] = [];
  const movedStubs: Recording[] = [];
  for (const spec of controlTarget?.recordings ?? []) {
    const name = spec.caseId.slice('control/'.length);
    const cassette = readCassette(cassettePath(root, spec));
    const stub = await spec.record({ kind: 'stub' });
    const recording = cassette ? await replay(spec, cassette) : stub;
    placed.push(recording);
    files.push({ path: join(controlDir, `${name}.jsonl`), content: toJsonl(recording) });
    if (cassette) {
      anyStubMoved = true;
      movedStubs.push(stub);
      files.push({ path: join(stubRoot, 'corpus', 'control', `${name}.jsonl`), content: toJsonl(stub) });
    }
  }
  files.push(...lockerFiles(join(controlDir, 'locker'), placed));
  if (movedStubs.length > 0) files.push(...lockerFiles(join(stubRoot, 'corpus', 'control', 'locker'), movedStubs));
  if (anyStubMoved) files.push({ path: join(stubRoot, 'README.md'), content: STUB_README });
  return { files, authoring };
}

/** Every locker directory the recorder owns, so stale blobs are cleared before a render. */
function ownedLockerDirs(root: string): string[] {
  const dirs = [join(root, 'corpus', 'control', 'locker'), join(root, 'recordings', 'stub', 'corpus', 'control', 'locker')];
  for (const target of TARGETS.filter((candidate) => candidate.id !== 'control')) {
    dirs.push(join(root, 'cases', target.id, 'locker'), join(root, 'recordings', 'stub', 'cases', target.id, 'locker'));
  }
  return dirs;
}

// ---------------------------------------------------------------------------------------------
// Planning: what a live take would cost, estimated from the stub run. Spends nothing.

/** The Haiku 5.5 tokenizer counts about 30% more tokens than the four-characters rule. */
const TOKENIZER_MARGIN = 1.3;
/** Live replies run longer than the stub's one-line answers. */
const OUTPUT_MARGIN = 2.5;
/** Haiku 5.5 does not cache a prefix shorter than this. */
const CACHE_MINIMUM_TOKENS = 512;

export interface PlanRow {
  label: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  prefixTokens: number;
  uncachedUsd: number;
  cachedUsd: number;
}

export async function planRecording(spec: RecordingSpec): Promise<PlanRow> {
  const row: PlanRow = { label: `${spec.caseId} ${spec.variant}`, calls: 0, inputTokens: 0, outputTokens: 0, prefixTokens: 0, uncachedUsd: 0, cachedUsd: 0 };
  const observe = (request: MessagesRequest, response: MessagesResponse): void => {
    const input = Math.ceil(response.usage.input_tokens * TOKENIZER_MARGIN);
    const output = Math.ceil(response.usage.output_tokens * TOKENIZER_MARGIN * OUTPUT_MARGIN);
    const prefix = Math.ceil(estimateTokens(JSON.stringify({ t: request.tools ?? [], s: request.system ?? '' })) * TOKENIZER_MARGIN);
    const cacheable = prefix >= CACHE_MINIMUM_TOKENS;
    // After the first call the prefix is read from the cache; the first call writes it.
    const read = cacheable && row.calls > 0 ? prefix : 0;
    const written = cacheable && row.calls === 0 ? prefix : 0;
    row.calls += 1;
    row.inputTokens += input;
    row.outputTokens += output;
    row.prefixTokens = Math.max(row.prefixTokens, prefix);
    row.uncachedUsd += costUsd(LIVE_MODEL, { input_tokens: input, output_tokens: output });
    row.cachedUsd += costUsd(LIVE_MODEL, { input_tokens: input - read - written, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: written });
  };
  await spec.record({ kind: 'stub', observe });
  const factor = spec.plannedCallsPerSession ?? 1;
  if (factor !== 1) {
    row.label = `${row.label} (est.)`;
    row.calls = Math.round(row.calls * factor);
    row.inputTokens = Math.round(row.inputTokens * factor * factor);
    row.outputTokens = Math.round(row.outputTokens * factor);
    row.uncachedUsd *= factor * factor;
    row.cachedUsd *= factor * factor;
  }
  return row;
}

export function formatPlan(rows: readonly PlanRow[], spentSoFar: number): string {
  const card = rateCard(LIVE_MODEL, 0);
  const lines = [
    `Live recording plan on ${LIVE_MODEL} ($${card.inputPerMillion} input, $${card.outputPerMillion} output, $${card.cacheReadPerMillion} cache read per million). Estimates from the stub run:`,
    'input tokens are the stub count times 1.3 for the tokenizer; output is the stub count times 1.3 times 2.5 because live replies are longer.',
    '',
    'recording                                            calls   input tok  output tok  prefix tok  uncached $  with cache $',
  ];
  for (const row of rows) {
    lines.push(
      [
        row.label.padEnd(52),
        String(row.calls).padStart(5),
        String(row.inputTokens).padStart(11),
        String(row.outputTokens).padStart(11),
        `${row.prefixTokens}${row.prefixTokens < CACHE_MINIMUM_TOKENS ? '*' : ' '}`.padStart(11),
        row.uncachedUsd.toFixed(4).padStart(11),
        row.cachedUsd.toFixed(4).padStart(13),
      ].join(' '),
    );
  }
  const sum = (pick: (row: PlanRow) => number) => rows.reduce((total, row) => total + pick(row), 0);
  lines.push(
    [
      'total'.padEnd(52),
      String(sum((row) => row.calls)).padStart(5),
      String(sum((row) => row.inputTokens)).padStart(11),
      String(sum((row) => row.outputTokens)).padStart(11),
      ''.padStart(11),
      sum((row) => row.uncachedUsd).toFixed(4).padStart(11),
      sum((row) => row.cachedUsd).toFixed(4).padStart(13),
    ].join(' '),
    '',
    `* estimated prefix (tools and system prompt) below the ${CACHE_MINIMUM_TOKENS}-token cache minimum. The estimate leaves out the tool-use preamble the API adds, and the automatic`,
    '  breakpoint caches the growing conversation too, so live takes cache more than this: the "with cache" column is an upper bound.',
    `Ledger so far: $${spentSoFar.toFixed(4)} of the $${HARD_STOP_USD} hard stop.`,
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Live takes.

export async function recordLive(root: string, spec: RecordingSpec, take: number, ledger: Ledger): Promise<Cassette> {
  const { terms } = loadTerms(process.env, root);
  // Redaction needs the deny list. Without it a live take could commit a banned term.
  if (terms.length === 0) throw new Error('The deny list is empty: set DENY_LIST or create .denylist before a live take.');
  // The home-path check is built into check-terms rather than the list, so add it here too.
  const redactor = new Redactor([...terms, HOME_PATH]);
  const sink: CassetteEntry[] = [];
  const recordedOn = new Date().toISOString().slice(0, 10);
  const client = new LedgeredClient(AnthropicMessagesClient.fromEnv(), ledger, `${spec.caseId} ${spec.variant} take ${take}`);
  const live = await spec.record({ kind: 'live', client, redactor, take, recordedOn, sink });
  const cassette: Cassette = {
    meta: {
      kind: 'cassette',
      format: CASSETTE_FORMAT,
      case: spec.caseId,
      variant: spec.variant,
      model: LIVE_MODEL,
      recorded_on: recordedOn,
      rig_version: RIG_VERSION,
      take,
      redactions: { em_dashes: redactor.emDashes, denied_terms: redactor.deniedTerms },
    },
    entries: sink,
  };
  // The replay must reproduce the live take exactly, or the cassette is no use as the record.
  const replayed = await replay(spec, cassette);
  if (toJsonl(replayed) !== toJsonl(live)) throw new Error(`${spec.cassette}: the replay differs from the live take.`);
  const path = cassettePath(root, spec);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, writeCassette(cassette));
  return cassette;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function writeRender(root: string): Promise<number> {
  const { files, authoring } = await renderAll(root);
  for (const dir of ownedLockerDirs(root)) {
    if (existsSync(dir)) for (const name of readdirSync(dir)) rmSync(join(dir, name));
  }
  for (const file of [...files, ...authoring]) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.content);
  }
  return files.length;
}

async function main(): Promise<void> {
  const root = repoRoot();
  const liveList = argument('--live');
  if (liveList) {
    const targets = resolveTargets(liveList);
    const only = argument('--variant');
    const specs = targets.flatMap((target) => target.recordings).filter((spec) => !only || spec.variant === only || spec.caseId.endsWith(`/${only}`));
    const ledger = new Ledger();
    const rows: PlanRow[] = [];
    for (const spec of specs) rows.push(await planRecording(spec));
    console.log(formatPlan(rows, ledger.total()));
    if (process.argv.includes('--dry-run')) return;
    const take = Number(argument('--take') ?? '1');
    for (const spec of specs) {
      const cassette = await recordLive(root, spec, take, ledger);
      console.log(`recorded ${spec.cassette}: ${cassette.entries.length} calls, ledger total $${ledger.total().toFixed(4)}`);
    }
    // --no-render lets two takes run side by side; render once both have finished.
    if (!process.argv.includes('--no-render')) console.log(`Rendered ${await writeRender(root)} files.`);
    return;
  }
  if (process.argv.includes('--check')) {
    const { files } = await renderAll(root);
    const stale = files.filter((file) => !existsSync(file.path) || readFileSync(file.path, 'utf8') !== file.content);
    if (stale.length > 0) {
      console.error(`${stale.length} recorded file(s) differ from a fresh render:`);
      for (const file of stale.slice(0, 20)) console.error(`  ${file.path.slice(root.length + 1)}`);
      process.exit(1);
    }
    console.log(`All ${files.length} recorded files match a fresh render (stub scripts re-run, any live cassettes replayed).`);
    return;
  }
  console.log(`Wrote ${await writeRender(root)} recorded files.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
