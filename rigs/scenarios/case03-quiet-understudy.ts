/**
 * Case 3, The Quiet Understudy. Ardsallow and Fennach Ferry Cooperative.
 *
 * A web-chat sailings desk answers questions about sailings. On 8 September the cooperative
 * rotates its API credentials; the assistant's copy of the key is not updated and the
 * availability API answers 503 from then on. In the incident variant the harness falls back
 * to the published timetable without telling the model and records the tool call as ok.
 * In the fixed variant the fallback is announced and marked, and the key is restored next day.
 */
import { z } from 'zod';
import { runAgent, type AgentConfig } from '../agent.js';
import { Rng } from '../clock.js';
import { fetchWithFallback, type Upstream } from '../components/upstream.js';
import { FaultPlan } from '../faults.js';
import { addDays, bst, longDate, makeEnv, type Recording, type RecordingMode, type ScenarioEnv } from '../scenario.js';
import { callTool, lastToolResult, say, type StubScript, type StubTurnContext } from '../stub.js';
import { defineTool, type Tool } from '../tools.js';

export const CASE_ID = '03-the-quiet-understudy';
const EPOCH = '2026-09-01T06:00:00Z';
const START_DATE = '2026-09-01';
const DAYS = 28;
const PROMPT_CHANGE_MS = bst('2026-09-08', '09:00');
const ROTATION_MS = bst('2026-09-08', '14:00');
const KEY_RESTORED_MS = bst('2026-09-09', '10:20');

type RouteId = 'ardsallow-fennach' | 'fennach-ardsallow';
const ROUTES: Record<RouteId, { from: string; to: string; departures: string[] }> = {
  'ardsallow-fennach': { from: 'Ardsallow', to: 'Fennach', departures: ['07:10', '09:30', '12:15', '15:40', '18:05'] },
  'fennach-ardsallow': { from: 'Fennach', to: 'Ardsallow', departures: ['08:20', '10:45', '13:30', '16:55', '19:15'] },
};
const EARLY = new Set(['07:10', '08:20']);
const API = 'https://api.ardsallow-ferries.example.scot/v2/availability';
const OFFICE_PHONE = '01632 960 418';

/** Stable small hash so capacity does not depend on the order calls are made in. */
function hash(text: string): number {
  let value = 2166136261;
  for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619) >>> 0;
  return value;
}

function arrival(depart: string): string {
  const [h, m] = depart.split(':').map(Number) as [number, number];
  const total = h * 60 + m + 50;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

interface Sailing {
  depart: string;
  arrive: string;
  vessel: string;
  status: string;
  reason?: string;
  car_spaces?: number;
  foot_spaces?: number;
}

function liveSailings(route: RouteId, date: string): Sailing[] {
  const refit = date >= '2026-09-15' && date <= '2026-09-26';
  return ROUTES[route].departures.map((depart) => {
    const base = { depart, arrive: arrival(depart), vessel: refit ? 'MV Gannet' : 'MV Ardsallow Lass' };
    if (refit && EARLY.has(depart)) return { ...base, status: 'cancelled', reason: 'vessel refit' };
    if (date === '2026-09-23' && depart >= '15:00') return { ...base, status: 'cancelled', reason: 'forecast gale' };
    const seed = hash(`${route}|${date}|${depart}`);
    return { ...base, status: 'running', car_spaces: seed % 29, foot_spaces: 40 + (seed % 97) };
  });
}

function timetable(route: RouteId, date: string): string {
  return JSON.stringify({
    source_document: 'Summer timetable 2026, published 31 August',
    route,
    date,
    sailings: ROUTES[route].departures.map((depart) => ({ depart, arrive: arrival(depart), vessel: 'MV Ardsallow Lass', status: 'scheduled' })),
  });
}

/** Everything that differs between the incident, the fixed recording and the control traces. */
export interface SailingsDeskOptions {
  caseId: string;
  variant: 'incident' | 'fixed' | 'control';
  epochIso: string;
  startDate: string;
  days: number;
  seed: number;
  scheduleSeed: number;
  /** When the availability API starts rejecting the assistant's key. Null for no outage. */
  rotationMs: number | null;
  /** When the key is put right. Null for never. */
  keyRestoredMs: number | null;
  promptChangeMs: number;
  silentFallback: boolean;
  mode?: RecordingMode;
}

function availability(route: RouteId, date: string, options: SailingsDeskOptions): Upstream {
  return (atMs) => {
    const keyRejected = options.rotationMs !== null && atMs >= options.rotationMs && (options.keyRestoredMs === null || atMs < options.keyRestoredMs);
    if (keyRejected) return { status: 503, body: '{"error":"service_unavailable"}', latencyMs: 8 };
    const body = { route, date, generated_at: new Date(atMs).toISOString(), sailings: liveSailings(route, date) };
    return { status: 200, body: JSON.stringify(body), latencyMs: 860 + (hash(String(atMs)) % 120) };
  };
}

function tools(options: SailingsDeskOptions): Tool[] {
  const checkSailings = defineTool({
    name: 'check_sailings',
    description: 'Sailings for one route on one date, with status and remaining car and foot spaces.',
    input: z.object({ route: z.enum(['ardsallow-fennach', 'fennach-ardsallow']), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict(),
    execute: (input, context) =>
      fetchWithFallback(context, {
        method: 'GET',
        url: `${API}?route=${input.route}&date=${input.date}`,
        upstream: availability(input.route, input.date, options),
        snapshot: { body: timetable(input.route, input.date), label: 'the published summer timetable of 31 August', readLatencyMs: 4 },
      }),
  });
  const getFares = defineTool({
    name: 'get_fares',
    description: 'Single and return fares for a vehicle and a number of adults.',
    input: z.object({ route: z.enum(['ardsallow-fennach', 'fennach-ardsallow']), vehicle: z.enum(['none', 'car', 'campervan']), adults: z.number().int().min(1).max(9) }).strict(),
    execute: async (input, context) => {
      context.clock.advance(3);
      const vehicle = { none: 0, car: 24.6, campervan: 41.2 }[input.vehicle];
      const single = Math.round((vehicle + input.adults * 6.9) * 100) / 100;
      return { content: JSON.stringify({ ...input, single_fare_gbp: single, return_fare_gbp: Math.round(single * 1.83 * 100) / 100 }), source: 'fares-table' };
    },
  });
  return [checkSailings, getFares];
}

function systemPrompt(version: 14 | 15): string {
  const base =
    'You are the sailings desk for the Ardsallow and Fennach Ferry Cooperative. Use check_sailings for any question about a sailing ' +
    'and never quote a sailing from memory. Quote car and foot spaces when the tool gives them. Keep answers short and plain.';
  return version === 15 ? `${base} End every reply with: Safe crossing.` : base;
}

type Kind = 'one-sailing' | 'day-and-fare' | 'campervan';
interface Session {
  at: number;
  kind: Kind;
  route: RouteId;
  date: string;
  depart: string;
  visitor: number;
}

function question(session: Session): string {
  const { from, to } = ROUTES[session.route];
  const day = longDate(session.date);
  if (session.kind === 'one-sailing') return `Is the ${session.depart} from ${from} running on ${day}? I am taking the car over.`;
  if (session.kind === 'campervan') return `Is there room for a campervan on the ${session.depart} from ${from} on ${day}?`;
  return `What sailings are there from ${from} to ${to} on ${day}, and what does a car with two adults cost?`;
}

function schedule(options: SailingsDeskOptions): Session[] {
  const rng = new Rng(options.scheduleSeed);
  const sessions: Session[] = [];
  let visitor = 0;
  for (let day = 0; day < options.days; day++) {
    const date = addDays(options.startDate, day);
    const times =
      date === '2026-09-08'
        ? ['08:40', '11:20', '16:05']
        : Array.from({ length: rng.pick([2, 3, 3]) }, () => `${String(rng.int(7, 20)).padStart(2, '0')}:${String(rng.int(0, 59)).padStart(2, '0')}`).sort();
    for (const time of times) {
      const route = rng.pick(['ardsallow-fennach', 'fennach-ardsallow'] as const);
      const travelDate = addDays(date, rng.int(0, 5));
      const early = travelDate >= '2026-09-15' && rng.next() < 0.45;
      const departures = ROUTES[route].departures;
      const depart = early ? (departures[0] ?? '07:10') : rng.pick(departures);
      const kind = rng.pick(['one-sailing', 'one-sailing', 'day-and-fare', 'campervan'] as const);
      sessions.push({ at: bst(date, time), kind, route, date: travelDate, depart, visitor: ++visitor });
    }
  }
  return sessions;
}

interface Reading {
  mode: 'live' | 'unmarked' | 'announced';
  sailings: Sailing[];
}

function read(result: string | null): Reading {
  const data = JSON.parse(result ?? '{}') as { notice?: string; generated_at?: string; sailings?: Sailing[]; snapshot?: { sailings: Sailing[] } };
  if (data.notice) return { mode: 'announced', sailings: data.snapshot?.sailings ?? [] };
  return { mode: data.generated_at ? 'live' : 'unmarked', sailings: data.sailings ?? [] };
}

function describe(sailing: Sailing, kind: Kind): string {
  if (sailing.status === 'cancelled') return `cancelled (${sailing.reason})`;
  if (sailing.car_spaces === undefined) return 'running. I do not have a space count for it, but it is not shown as full';
  if (kind === 'campervan') return sailing.car_spaces >= 2 ? `running, with room for a campervan (${sailing.car_spaces} vehicle spaces left)` : 'running but has no room for a campervan';
  return `running, with ${sailing.car_spaces} car spaces left`;
}

function answer(session: Session, reading: Reading, fare: string | null, signOff: boolean): string {
  const { from, to } = ROUTES[session.route];
  const day = longDate(session.date);
  let text: string;
  if (reading.mode === 'announced') {
    text =
      `I cannot see live sailing information just now. The published timetable lists ${session.kind === 'day-and-fare' ? 'sailings' : `the ${session.depart}`} from ${from} on ${day}, ` +
      `but it does not show cancellations or spaces. Please check the service status page or call the office on ${OFFICE_PHONE} before you travel.`;
  } else if (session.kind === 'day-and-fare') {
    const list = reading.sailings.map((sailing) => `${sailing.depart} ${sailing.status === 'cancelled' ? `(cancelled, ${sailing.reason})` : sailing.car_spaces === undefined ? '(running)' : `(${sailing.car_spaces} car spaces)`}`);
    text = `Sailings from ${from} to ${to} on ${day}: ${list.join(', ')}.`;
  } else {
    const sailing = reading.sailings.find((candidate) => candidate.depart === session.depart);
    text = sailing ? `The ${session.depart} from ${from} on ${day} is ${describe(sailing, session.kind)}.` : `I cannot find a ${session.depart} from ${from} on ${day}.`;
    const next = reading.sailings.find((candidate) => candidate.depart > session.depart && candidate.status === 'running');
    if (sailing?.status === 'cancelled' && next) text += ` The next sailing that day is the ${next.depart}, ${describe(next, session.kind)}.`;
  }
  if (fare) text += ` ${fare}`;
  return signOff ? `${text} Safe crossing.` : text;
}

function script(session: Session): StubScript {
  const check = (context: StubTurnContext) => callTool(context, 'check_sailings', { route: session.route, date: session.date });
  const signOff = (context: StubTurnContext) => (context.request.system ?? '').includes('Safe crossing');
  if (session.kind !== 'day-and-fare') {
    return { 0: check, 1: (context) => say(answer(session, read(lastToolResult(context.request)), null, signOff(context))) };
  }
  let sailings: Reading | null = null;
  return {
    0: check,
    1: (context) => {
      sailings = read(lastToolResult(context.request));
      return callTool(context, 'get_fares', { route: session.route, vehicle: 'car', adults: 2 });
    },
    2: (context) => {
      const fare = JSON.parse(lastToolResult(context.request) ?? '{}') as { single_fare_gbp?: number };
      const fareText = `A car with two adults is £${(fare.single_fare_gbp ?? 0).toFixed(2)} single.`;
      return say(answer(session, sailings ?? read(null), fareText, signOff(context)));
    },
  };
}

function agentConfig(env: ScenarioEnv, options: SailingsDeskOptions, promptVersion: 14 | 15): AgentConfig {
  return {
    name: 'sailings-desk',
    model: env.model,
    system: systemPrompt(promptVersion),
    tools: tools(options),
    maxTurns: 6,
    maxTokens: 1024,
    client: env.client,
    clock: env.clock,
    trace: env.trace,
    faults: env.faults,
  };
}

export function recordCase03(variant: 'incident' | 'fixed', mode: RecordingMode = { kind: 'stub' }): Promise<Recording> {
  return recordSailingsDesk({
    caseId: CASE_ID,
    variant,
    epochIso: EPOCH,
    startDate: START_DATE,
    days: DAYS,
    seed: 3_003,
    scheduleSeed: 31_003,
    rotationMs: ROTATION_MS,
    keyRestoredMs: variant === 'incident' ? null : KEY_RESTORED_MS,
    promptChangeMs: PROMPT_CHANGE_MS,
    silentFallback: variant === 'incident',
    mode,
  });
}

export async function recordSailingsDesk(options: SailingsDeskOptions): Promise<Recording> {
  const faults = options.silentFallback ? new FaultPlan([{ name: 'upstream_503_silent_fallback' }]) : FaultPlan.none();
  const env = makeEnv(options.epochIso, options.seed, faults, options.mode);
  const faultedTraceIds: string[] = [];
  for (const session of schedule(options)) {
    env.clock.set(session.at);
    const promptVersion = session.at >= options.promptChangeMs ? 15 : 14;
    const traceId = env.trace.newTraceId();
    env.script(script(session));
    await runAgent(agentConfig(env, options, promptVersion), {
      traceId,
      identity: { subject: `web-visitor-${session.visitor}`, role: 'customer', tenant: 'ardsallow-ferries' },
      messages: [{ role: 'user', content: env.userTurn(question(session)) }],
      fields: {
        'deployment.environment.name': 'production',
        attributes: { 'prompt.version': `sailings-desk/${promptVersion}`, 'session.channel': 'web-chat' },
      },
    });
    if (options.silentFallback && options.rotationMs !== null && session.at >= options.rotationMs) faultedTraceIds.push(traceId);
  }
  return {
    header: env.header({
      caseId: options.caseId,
      variant: options.variant,
      epochIso: options.epochIso,
      redactions: [{ field: 'customer identity', method: 'replaced with sequential web-visitor numbers' }],
    }),
    events: env.trace.events(),
    blobs: env.trace.blobs,
    faultedTraceIds,
  };
}

