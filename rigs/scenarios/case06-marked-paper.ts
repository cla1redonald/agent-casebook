/**
 * Case 6, The Marked Paper. Glenarrow Council planning desk.
 *
 * Residents ask a planning assistant about applications through the council website. The
 * HTTP adapter verifies the session token and rejects bodies over 1 MiB with a 413. The nightly
 * eval in the incident variant calls the handler in-process, identifying itself with an
 * x-eval-user header the handler trusts, so it never meets the body limit or the auth check and
 * scores 100%. Residents who attach drawings get a 413. In the fixed variant the eval goes through
 * the adapter with a test account and includes attachment fixtures; the limit is raised to match.
 */
import { z } from 'zod';
import { runAgent, type AgentConfig } from '../agent.js';
import { Rng } from '../clock.js';
import { runEvalCase, type EvalCase } from '../components/eval-runner.js';
import { HttpAdapter, type Handler } from '../components/http-adapter.js';
import { httpCall } from '../components/upstream.js';
import { FaultPlan } from '../faults.js';
import { addDays, bst, makeEnv, type Recording, type RecordingMode, type ScenarioEnv } from '../scenario.js';
import { callTool, lastToolResult, say, type StubScript } from '../stub.js';
import { defineTool, type Identity, type Tool } from '../tools.js';

export const CASE_ID = '06-the-marked-paper';
const EPOCH = '2026-09-13T23:00:00Z';
const START_DATE = '2026-09-14';
const DAYS = 7;
export const MIB = 1_048_576;
const TENANT = 'glenarrow-council';
const EVAL_TOKEN = 'eval-account';

function hash(text: string): number {
  let value = 2166136261;
  for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619) >>> 0;
  return value;
}

const APPLICATIONS: Record<string, { address: string; proposal: string; status: string; closes: string; due: string }> = {
  '26/01432/FUL': { address: '27 Station Road', proposal: 'two-storey rear extension', status: 'under consideration', closes: '2 October', due: '30 October' },
  '26/01388/LBC': { address: 'The Old Schoolhouse, Burnside Lane', proposal: 'replacement sash windows', status: 'under consideration', closes: '25 September', due: '16 October' },
  '26/01501/FUL': { address: '9 Tannery Close', proposal: 'change of use to a cafe', status: 'awaiting validation', closes: 'not yet set', due: 'not yet set' },
  '26/01297/PPP': { address: 'Land north of Kirk Brae', proposal: 'four houses (planning in principle)', status: 'decided: refused', closes: 'closed', due: 'decided on 9 September' },
};
const CONSERVATION: Record<string, string | null> = {
  '14 Mill Wynd': 'Glenarrow Town Centre',
  '3 Kirk Brae': 'Glenarrow Town Centre',
  '27 Station Road': null,
  '41 Burnside Lane': 'Burnside',
  '6 Larch Grove': null,
};
const POLICY: Record<string, string> = {
  dormer: 'Dormer extensions: submit a location plan, existing and proposed elevation drawings, a roof plan and a floor plan.',
  outbuilding: 'Garden rooms and sheds under 2.5 metres high, behind the front wall of the house and covering less than half the garden, do not usually need an application. Conservation areas and listed buildings differ.',
  windows: 'Replacement windows in a conservation area need an application unless they match the existing in material and pattern.',
};

function tools(): Tool[] {
  const lookup = defineTool({
    name: 'lookup_application',
    description: 'Status, consultation dates and proposal for one planning application reference.',
    input: z.object({ reference: z.string().regex(/^\d{2}\/\d{5}\/[A-Z]{3}$/) }).strict(),
    execute: async (input, context) => {
      const reply = await httpCall(context, 'GET', `https://register.glenarrow.example.scot/api/applications/${encodeURIComponent(input.reference)}`, (atMs) => {
        const record = APPLICATIONS[input.reference];
        return record
          ? { status: 200, body: JSON.stringify({ reference: input.reference, ...record }), latencyMs: 280 + (hash(String(atMs)) % 80) }
          : { status: 404, body: '{"error":"not_found"}', latencyMs: 120 };
      });
      if (reply.status === 404) return { content: `No application ${input.reference} on the register.`, isError: true, errorType: '404', source: 'register' };
      return { content: reply.body, source: 'register' };
    },
  });
  const constraints = defineTool({
    name: 'check_constraints',
    description: 'Planning constraints (conservation area, listed building, tree preservation) for an address.',
    input: z.object({ address: z.string().min(3) }).strict(),
    execute: async (input, context) => {
      const reply = await httpCall(context, 'GET', `https://gis.glenarrow.example.scot/constraints?address=${encodeURIComponent(input.address)}`, (atMs) => {
        const hour = new Date(atMs + 3_600_000).getUTCHours();
        const busy = hour >= 9 && hour < 17;
        if (busy && hash(`gis|${atMs}`) % 100 < 40) return { status: 504, body: '{"error":"gateway_timeout"}', latencyMs: 10_000 };
        const area = CONSERVATION[input.address] ?? null;
        const body = { address: input.address, conservation_area: area, listed_building: false, tree_preservation_order: false };
        return { status: 200, body: JSON.stringify(body), latencyMs: 540 + (hash(String(atMs)) % 140) };
      });
      if (reply.status >= 500) return { content: `The constraints map timed out (${reply.status}).`, isError: true, errorType: String(reply.status), source: 'gis' };
      return { content: reply.body, source: 'gis' };
    },
  });
  const policy = defineTool({
    name: 'search_policy',
    description: 'Searches the council planning guidance and returns the closest passage.',
    input: z.object({ topic: z.enum(['dormer', 'outbuilding', 'windows']) }).strict(),
    execute: async (input, context) => {
      context.clock.advance(15);
      return { content: POLICY[input.topic] ?? '', source: 'policy-index' };
    },
  });
  return [lookup, constraints, policy];
}

type Spec =
  | { kind: 'status'; reference: string }
  | { kind: 'closes'; reference: string }
  | { kind: 'constraints'; address: string }
  | { kind: 'policy'; topic: 'dormer' | 'outbuilding' }
  | { kind: 'garden-room'; address: string };

function questionFor(spec: Spec, attachment: boolean): string {
  switch (spec.kind) {
    case 'status':
      return `What is happening with application ${spec.reference}? I live next door.`;
    case 'closes':
      return `When does the consultation close for ${spec.reference}?`;
    case 'constraints':
      return `Is ${spec.address} in a conservation area? I want to replace the windows.`;
    case 'policy':
      return spec.topic === 'dormer'
        ? 'I want to build a dormer extension. What drawings do I need to send?'
        : 'Do I need to apply to put up a garden shed under 2.5 metres?';
    case 'garden-room':
      return `${attachment ? 'I have attached my site plan. ' : ''}I want to build a garden room at ${spec.address}. Does it need an application?`;
  }
}

function applicationText(result: string): string {
  const record = JSON.parse(result) as { reference: string; address: string; proposal: string; status: string; closes: string; due: string };
  return `Application ${record.reference} (${record.proposal} at ${record.address}) is ${record.status}. The consultation closes on ${record.closes} and a decision is due by ${record.due}.`;
}

function constraintsText(result: string | null): string {
  if (!result || result.startsWith('The constraints map timed out')) return 'The constraints map is not responding just now, so I cannot confirm the conservation status; please try again later.';
  const record = JSON.parse(result) as { address: string; conservation_area: string | null };
  return record.conservation_area
    ? `${record.address} is in the ${record.conservation_area} conservation area, so replacement windows need an application unless they match the existing.`
    : `${record.address} is not in a conservation area.`;
}

function script(spec: Spec, attachment: boolean): StubScript {
  const timedOut = (result: string | null) => (result ?? '').startsWith('The constraints map timed out');
  switch (spec.kind) {
    case 'status':
    case 'closes':
      return {
        0: (context) => callTool(context, 'lookup_application', { reference: spec.reference }),
        1: (context) => say(applicationText(lastToolResult(context.request) ?? '{}')),
      };
    case 'policy':
      return {
        0: (context) => callTool(context, 'search_policy', { topic: spec.topic }),
        1: (context) => say(lastToolResult(context.request) ?? ''),
      };
    case 'constraints':
      return {
        0: (context) => callTool(context, 'check_constraints', { address: spec.address }),
        1: (context) => {
          const result = lastToolResult(context.request);
          return timedOut(result) ? callTool(context, 'check_constraints', { address: spec.address }, 'The map timed out. Trying once more.') : say(constraintsText(result));
        },
        2: (context) => say(constraintsText(lastToolResult(context.request))),
      };
    case 'garden-room': {
      let constraintNote = '';
      return {
        0: (context) => callTool(context, 'check_constraints', { address: spec.address }),
        1: (context) => {
          constraintNote = constraintsText(lastToolResult(context.request));
          return callTool(context, 'search_policy', { topic: 'outbuilding' });
        },
        2: () => say(`${attachment ? 'Thank you for the site plan. ' : ''}${constraintNote} A garden room under 2.5 metres high behind the house does not usually need an application.`),
      };
    }
  }
}

function agentConfig(env: ScenarioEnv): AgentConfig {
  return {
    name: 'planning-desk',
    model: env.model,
    system:
      'You are the Glenarrow Council planning desk. Answer residents about planning applications and guidance using the tools. ' +
      'Quote references exactly. Do not give a formal planning opinion; say when an application is needed.',
    tools: tools(),
    maxTurns: 6,
    maxTokens: 1024,
    client: env.client,
    clock: env.clock,
    trace: env.trace,
    faults: env.faults,
  };
}

interface Payload {
  question: string;
  attachments: string[];
}

function makeHandler(env: ScenarioEnv, trustEvalHeader: boolean, specs: Map<string, Spec>): Handler {
  return async (request, context) => {
    const evalHeader = request.headers['x-eval-user'];
    // The incident's handler trusts this header when no adapter identity is present. The fix removes that path.
    const identity: Identity | null =
      context.identity ?? (trustEvalHeader && evalHeader ? { subject: evalHeader, role: 'eval', tenant: TENANT } : null);
    if (!identity) return { status: 401, body: 'Not authenticated.' };
    const payload = JSON.parse(request.body) as Payload;
    const spec = specs.get(payload.question);
    if (!spec) return { status: 400, body: 'Unknown question.' };
    env.script(script(spec, payload.attachments.length > 0));
    const attached = payload.attachments.length > 0 ? `\n[Attached: ${payload.attachments.join(', ')}]` : '';
    const result = await runAgent(agentConfig(env), {
      traceId: context.traceId,
      parentSpanId: context.parentSpanId,
      identity,
      messages: [{ role: 'user', content: env.userTurn(`${payload.question}${attached}`) }],
      fields: {
        'deployment.environment.name': identity.role === 'eval' ? 'eval' : 'production',
        attributes: { 'app.request.header_names': Object.keys(request.headers).sort() },
      },
    });
    return { status: result.outcome === 'end_turn' ? 200 : 500, body: result.text };
  };
}

const EVAL_CASES: Array<{ id: string; spec: Spec; attachmentBytes: number; expect: string | RegExp; fixedOnly?: boolean }> = [
  // Each check looks for a fact the tools supply, not for the script's wording, so it scores a live answer fairly.
  { id: 'status-lookup', spec: { kind: 'status', reference: '26/01432/FUL' }, attachmentBytes: 0, expect: '26/01432/FUL' },
  { id: 'shed-guidance', spec: { kind: 'policy', topic: 'outbuilding' }, attachmentBytes: 0, expect: /2\.5\s?(metres|m\b)/i },
  { id: 'conservation-check', spec: { kind: 'constraints', address: '14 Mill Wynd' }, attachmentBytes: 0, expect: /Glenarrow Town Centre/i },
  { id: 'consultation-date', spec: { kind: 'closes', reference: '26/01388/LBC' }, attachmentBytes: 0, expect: /25(th)? September/i },
  { id: 'dormer-drawings', spec: { kind: 'policy', topic: 'dormer' }, attachmentBytes: 0, expect: /elevation/i },
  { id: 'garden-room-small-plan', spec: { kind: 'garden-room', address: '6 Larch Grove' }, attachmentBytes: 2_400_000, expect: /conservation/i, fixedOnly: true },
  { id: 'garden-room-large-plan', spec: { kind: 'garden-room', address: '41 Burnside Lane' }, attachmentBytes: 5_100_000, expect: /conservation/i, fixedOnly: true },
];

interface ProductionSession {
  at: number;
  spec: Spec;
  attachmentBytes: number;
  resident: number;
}

/** Everything that differs between the incident, the fixed recording and the control traces. */
export interface PlanningDeskOptions {
  caseId: string;
  variant: 'incident' | 'fixed' | 'control';
  epochIso: string;
  startDate: string;
  days: number;
  seed: number;
  scheduleSeed: number;
  inProcessEval: boolean;
  maxBodyBytes: number;
  runEvals: boolean;
  runProduction: boolean;
  includeAttachmentEvals: boolean;
  /** Residents whose session token has expired, to exercise the adapter's 401. */
  expiredResidents?: number[];
  mode?: RecordingMode;
}

function productionSchedule(options: PlanningDeskOptions): ProductionSession[] {
  const rng = new Rng(options.scheduleSeed);
  const sessions: ProductionSession[] = [];
  let resident = 0;
  const references = Object.keys(APPLICATIONS);
  const addresses = Object.keys(CONSERVATION);
  for (let day = 0; day < options.days; day++) {
    const date = addDays(options.startDate, day);
    const count = rng.pick([4, 5, 5, 6]);
    const times = Array.from({ length: count }, () => `${String(rng.int(8, 19)).padStart(2, '0')}:${String(rng.int(0, 59)).padStart(2, '0')}`).sort();
    for (const time of times) {
      const roll = rng.next();
      const spec: Spec =
        roll < 0.2 ? { kind: 'status', reference: rng.pick(references) }
        : roll < 0.3 ? { kind: 'closes', reference: rng.pick(references) }
        : roll < 0.55 ? { kind: 'constraints', address: rng.pick(addresses) }
        : roll < 0.62 ? { kind: 'policy', topic: rng.pick(['dormer', 'outbuilding'] as const) }
        : { kind: 'garden-room', address: rng.pick(addresses) };
      const attachmentBytes =
        spec.kind === 'garden-room' ? rng.int(1_400_000, 6_200_000)
        : spec.kind === 'constraints' && rng.next() < 0.3 ? rng.int(300_000, 2_900_000)
        : 0;
      sessions.push({ at: bst(date, time), spec, attachmentBytes, resident: ++resident });
    }
  }
  return sessions;
}

export function recordCase06(variant: 'incident' | 'fixed', mode: RecordingMode = { kind: 'stub' }): Promise<Recording> {
  return recordPlanningDesk({
    caseId: CASE_ID,
    variant,
    epochIso: EPOCH,
    startDate: START_DATE,
    days: DAYS,
    seed: 6_006,
    scheduleSeed: 61_006,
    inProcessEval: variant === 'incident',
    maxBodyBytes: variant === 'incident' ? MIB : 25 * MIB,
    runEvals: true,
    runProduction: true,
    includeAttachmentEvals: variant === 'fixed',
    mode,
  });
}

export async function recordPlanningDesk(options: PlanningDeskOptions): Promise<Recording> {
  const faults = options.inProcessEval ? new FaultPlan([{ name: 'in_process_eval_bypass' }]) : FaultPlan.none();
  const env = makeEnv(options.epochIso, options.seed, faults, options.mode);
  const specs = new Map<string, Spec>();
  const handler = makeHandler(env, options.inProcessEval, specs);
  const production = options.runProduction ? productionSchedule(options) : [];
  const expired = new Set(options.expiredResidents ?? []);
  const tokens = new Map<string, Identity>([[EVAL_TOKEN, { subject: 'eval-account', role: 'eval', tenant: TENANT }]]);
  for (const session of production) {
    if (!expired.has(session.resident)) tokens.set(`resident-${session.resident}`, { subject: `resident-${session.resident}`, role: 'resident', tenant: TENANT });
  }
  const maxBodyBytes = options.maxBodyBytes;
  const adapter = (environment: string) =>
    new HttpAdapter({ maxBodyBytes, tokens, handler, trace: env.trace, clock: env.clock, fields: { 'deployment.environment.name': environment } });
  const productionAdapter = adapter('production');
  const evalAdapter = adapter('eval');
  const evalCases = EVAL_CASES.filter((evalCase) => options.includeAttachmentEvals || !evalCase.fixedOnly);
  const faultedTraceIds: string[] = [];

  type Item = { at: number; run: () => Promise<void> };
  const items: Item[] = [];
  for (let day = 0; day < (options.runEvals ? options.days : 0); day++) {
    const nightly = bst(addDays(options.startDate, day), '02:30');
    items.push({
      at: nightly,
      run: async () => {
        for (const evalCase of evalCases) {
          const definition: EvalCase = { id: evalCase.id, question: questionFor(evalCase.spec, evalCase.attachmentBytes > 0), attachmentBytes: evalCase.attachmentBytes, expect: evalCase.expect };
          specs.set(definition.question, evalCase.spec);
          const result = await runEvalCase(definition, {
            suite: 'planning-desk',
            adapter: evalAdapter,
            handler,
            trace: env.trace,
            clock: env.clock,
            faults: env.faults,
            testToken: EVAL_TOKEN,
            userAgent: 'glenarrow-eval/2.0',
          });
          if (options.inProcessEval) faultedTraceIds.push(result.traceId);
          env.clock.advance(1_000);
        }
      },
    });
  }
  for (const session of production) {
    items.push({
      at: session.at,
      run: async () => {
        const attachment = session.attachmentBytes > 0;
        const question = questionFor(session.spec, attachment);
        specs.set(question, session.spec);
        const body = JSON.stringify({ question, attachments: attachment ? [session.spec.kind === 'garden-room' ? 'site-plan.pdf' : 'window-photo.jpg'] : [] });
        await productionAdapter.handle(
          {
            method: 'POST',
            route: '/v1/ask',
            headers: { authorization: `Bearer resident-${session.resident}`, 'content-type': 'application/json', 'user-agent': 'glenarrow-web/4.2', 'x-request-id': env.trace.newTraceId().slice(0, 12) },
            body,
            bodyBytes: body.length + session.attachmentBytes,
          },
          env.trace.newTraceId(),
        );
      },
    });
  }
  items.sort((a, b) => a.at - b.at);
  for (const item of items) {
    env.clock.set(Math.max(item.at, env.clock.now()));
    await item.run();
  }
  return {
    header: env.header({
      caseId: options.caseId,
      variant: options.variant,
      epochIso: options.epochIso,
      redactions: [
        { field: 'resident identity', method: 'replaced with sequential resident numbers' },
        { field: 'request header values', method: 'header names recorded, values dropped' },
        { field: 'attachments', method: 'size recorded, content never stored' },
      ],
    }),
    events: env.trace.events(),
    blobs: env.trace.blobs,
    faultedTraceIds,
  };
}
