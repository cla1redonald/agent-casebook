import { SEMCONV, TRACE_FORMAT, type TraceEvent, type TraceHeader } from '../src/trace/schema.js';
import type { MessagesClient, MessagesRequest, MessagesResponse } from './client.js';
import { Rng, SimClock } from './clock.js';
import { FaultPlan } from './faults.js';
import { RecordingClient, ReplayClient, type Cassette, type CassetteEntry, type Redactor } from './live.js';
import { LIVE_PRICE_BASIS, PRICE_BASIS } from './pricing.js';
import { StubClient, type StubScript } from './stub.js';
import { TraceWriter } from './trace-writer.js';

/** Version of rigs/ that makes live recordings. */
export const RIG_VERSION = '0.2.0';
/** The stub recordings were made by rig 0.1.0; the current rig still reproduces them byte for byte. */
export const STUB_RIG_VERSION = '0.1.0';
/** Fixed so that re-recording on another day gives a byte-identical file. */
export const STUB_RECORDING_DATE = '2026-10-11';
/** The model the stub scripts stand in for, kept so the stub recordings stay byte-identical. */
export const PLANNED_MODEL = 'claude-sonnet-5-5';
/** The model live recordings use (Claire chose the cheap recording option). */
export const LIVE_MODEL = 'claude-haiku-5-5';

export type RecordingMode =
  /** `observe` sees every scripted call; the dry run uses it to estimate a live take. */
  | { kind: 'stub'; observe?: (request: MessagesRequest, response: MessagesResponse) => void }
  /** A live take: `client` is the real adapter behind the ledger; responses are redacted as they arrive and kept in `sink`. */
  | { kind: 'live'; client: MessagesClient; redactor: Redactor; take: number; recordedOn: string; sink: CassetteEntry[] }
  /** Renders a live take again from its cassette, with no network and no key. `progress` counts the calls used. */
  | { kind: 'replay'; cassette: Cassette; progress: { calls: number }; rehash?: boolean };

export interface ScenarioEnv {
  clock: SimClock;
  rng: Rng;
  trace: TraceWriter;
  /** The scripted model. Only answers in stub mode. */
  stub: StubClient;
  faults: FaultPlan;
  mode: RecordingMode;
  /** The client scenarios pass to the agent loop: the stub, the live recorder or the replayer. */
  client: MessagesClient;
  /** The model id scenarios request. */
  model: string;
  /** Loads a stub script for the next conversation. Does nothing in live and replay modes. */
  script(script: StubScript): void;
  /**
   * The text of a user turn. Live and replay modes prefix the date and time, as a production
   * chat front end does, after the cached prefix; without it the live model guesses the year.
   * Stub mode returns the text unchanged, so the stub recordings stay byte-identical.
   */
  userTurn(text: string): string;
  /** The trace header for this mode. Call it after the sessions have run. */
  header(options: HeaderOptions): TraceHeader;
}

export interface HeaderOptions {
  caseId: string;
  variant: TraceHeader['variant'];
  epochIso: string;
  redactions: TraceHeader['redactions'];
  /** Extra plain-language notes for the header, such as a reduced context size. */
  notes?: string[];
}

export function makeEnv(epochIso: string, seed: number, faults: FaultPlan, mode: RecordingMode = { kind: 'stub' }): ScenarioEnv {
  const epochMs = Date.parse(epochIso);
  const clock = new SimClock(epochMs);
  const stub = new StubClient(clock);
  const env: ScenarioEnv = {
    clock,
    rng: new Rng(seed),
    // Ids come from their own stream so adding a span never shifts the scenario's random draws.
    trace: new TraceWriter(clock, new Rng(seed ^ 0x5eed), epochMs),
    stub,
    faults,
    mode,
    client: stub,
    model: mode.kind === 'stub' ? PLANNED_MODEL : LIVE_MODEL,
    script: (script) => {
      if (mode.kind === 'stub') stub.load(script);
    },
    userTurn: (text) => (mode.kind === 'stub' ? text : `[${localStamp(clock.now())}] ${text}`),
    header: (options) => {
      if (mode.kind === 'stub') return stubHeader(options);
      const meta =
        mode.kind === 'live'
          ? { model: LIVE_MODEL, recordedOn: mode.recordedOn, take: mode.take, emDashes: mode.redactor.emDashes, deniedTerms: mode.redactor.deniedTerms }
          : {
              model: mode.cassette.meta.model,
              recordedOn: mode.cassette.meta.recorded_on,
              take: mode.cassette.meta.take,
              emDashes: mode.cassette.meta.redactions.em_dashes,
              deniedTerms: mode.cassette.meta.redactions.denied_terms,
            };
      return liveHeader({ ...options, ...meta });
    },
  };
  if (mode.kind === 'live') {
    env.client = new RecordingClient(mode.client, clock, mode.redactor, mode.sink);
  } else if (mode.kind === 'replay') {
    env.client = new ReplayClient(mode.cassette.entries, clock, `${mode.cassette.meta.case} ${mode.cassette.meta.variant}`, mode.progress, mode.rehash ?? false);
  } else if (mode.observe) {
    const observe = mode.observe;
    env.client = {
      provider: stub.provider,
      create: async (request) => {
        const response = await stub.create(request);
        observe(request, response);
        return response;
      },
    };
  }
  return env;
}

export interface Recording {
  header: TraceHeader;
  events: TraceEvent[];
  blobs: Map<string, string>;
  /** Trace ids where the injected fault shaped the session. Ground truth for evals. */
  faultedTraceIds: string[];
}

export function stubHeader(options: HeaderOptions): TraceHeader {
  return {
    kind: 'header',
    format: TRACE_FORMAT,
    semconv: { ...SEMCONV },
    case: options.caseId,
    variant: options.variant,
    recording: 'stub',
    model: `stub (scripted responses standing in for ${PLANNED_MODEL})`,
    recorded_on: STUB_RECORDING_DATE,
    rig_version: STUB_RIG_VERSION,
    clock: 'simulated',
    epoch: options.epochIso,
    cost_basis: PRICE_BASIS,
    redactions: options.redactions,
    note:
      'STUB RECORDING. Every model response in this file was produced by a deterministic script in rigs/scenarios, ' +
      'not by a live model. Timings come from a simulated clock. Live recording is pending (Phase 3b).',
  };
}

export function liveHeader(
  options: HeaderOptions & { model: string; recordedOn: string; take: number; emDashes: number; deniedTerms: number },
): TraceHeader {
  return {
    kind: 'header',
    format: TRACE_FORMAT,
    semconv: { ...SEMCONV },
    case: options.caseId,
    variant: options.variant,
    recording: 'live',
    model: options.model,
    recorded_on: options.recordedOn,
    rig_version: RIG_VERSION,
    clock: 'mixed',
    epoch: options.epochIso,
    cost_basis: LIVE_PRICE_BASIS,
    redactions: [
      ...options.redactions,
      { field: 'model output', method: `${options.emDashes} em dash(es) replaced with a spaced hyphen (house style check)` },
      { field: 'model output', method: `${options.deniedTerms} word(s) matching the project deny list replaced with [withheld]` },
    ],
    note: [
      `LIVE RECORDING. Every model response in this file came from ${options.model} through the Anthropic API, recorded on ${options.recordedOn} (take ${options.take}).`,
      'Session start times are scripted and the upstream services, tools and faults are simulated by the rig on purpose; model call durations are measured wall-clock time.',
      ...(options.notes ?? []),
    ].join(' '),
  };
}

/** "Monday 1 September 2026, 08:40" in UK time (BST through the scenarios' dates, GMT after 25 October). */
export function localStamp(atMs: number): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(atMs));
  const part = (type: string) => parts.find((candidate) => candidate.type === type)?.value ?? '';
  return `${part('weekday')} ${part('day')} ${part('month')} ${part('year')}, ${part('hour')}:${part('minute')}`;
}

export function toJsonl(recording: Pick<Recording, 'header' | 'events'>): string {
  return [recording.header, ...recording.events].map((line) => JSON.stringify(line)).join('\n') + '\n';
}

/** Local wall-clock helper: builds a UTC timestamp from a UK date and time in British Summer Time. */
export function bst(date: string, time: string): number {
  return Date.parse(`${date}T${time}:00+01:00`);
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;

/** "Friday 19 September" for an ISO date. */
export function longDate(isoDate: string): string {
  const date = new Date(`${isoDate}T12:00:00Z`);
  return `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

export function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
