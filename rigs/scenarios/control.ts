/**
 * The control corpus: ten clean traces from the same rig and stub with no faults injected.
 * They exercise every stop reason, schema rejection, retries with backoff, the turn limit,
 * an announced fallback, adapter rejections and an eval that goes through the adapter, so a
 * detector that fires here is firing on healthy behaviour.
 */
import { z } from 'zod';
import { runAgent } from '../agent.js';
import { ApiError, type MessagesClient, type MessagesRequest, type MessagesResponse } from '../client.js';
import { RetryPolicy } from '../components/retry.js';
import { httpCall } from '../components/upstream.js';
import { FaultPlan } from '../faults.js';
import { bst, makeEnv, type Recording, type RecordingMode, type ScenarioEnv } from '../scenario.js';
import { callTool, lastToolResult, say, type StubScript } from '../stub.js';
import { defineTool, type Tool } from '../tools.js';
import { recordSailingsDesk } from './case03-quiet-understudy.js';
import { MIB, recordPlanningDesk } from './case06-marked-paper.js';

interface DeskSession {
  at: number;
  subject: string;
  question: string;
  script: StubScript;
}

interface DeskOptions {
  caseId: string;
  epochIso: string;
  seed: number;
  agentName: string;
  system: string;
  role: string;
  tenant: string;
  tools: Tool[];
  sessions: (env: ScenarioEnv) => DeskSession[];
  maxTurns?: number;
  /** Model calls (1-based, across the whole recording) that fail once with a 529 before succeeding. */
  overloadedCalls?: number[];
  mode?: RecordingMode;
}

/** Wraps a client so chosen calls fail with a 529, to exercise retry with backoff. */
class OverloadedOnce implements MessagesClient {
  readonly provider: string;
  private calls = 0;
  constructor(
    private readonly inner: MessagesClient,
    private readonly failing: ReadonlySet<number>,
  ) {
    this.provider = inner.provider;
  }
  async create(request: MessagesRequest): Promise<MessagesResponse> {
    this.calls += 1;
    if (this.failing.has(this.calls)) throw new ApiError(529, 'overloaded');
    return this.inner.create(request);
  }
}

async function recordDesk(options: DeskOptions): Promise<Recording> {
  const env = makeEnv(options.epochIso, options.seed, FaultPlan.none(), options.mode);
  // The 529s are injected locally, in front of the client: they never reach the provider.
  const client = options.overloadedCalls ? new OverloadedOnce(env.client, new Set(options.overloadedCalls)) : env.client;
  const retry = new RetryPolicy({ clock: env.clock, rng: env.rng, faults: env.faults });
  for (const session of options.sessions(env)) {
    env.clock.set(session.at);
    env.script(session.script);
    await runAgent(
      {
        name: options.agentName,
        model: env.model,
        system: options.system,
        tools: options.tools,
        maxTurns: options.maxTurns ?? 6,
        maxTokens: 1024,
        client,
        clock: env.clock,
        trace: env.trace,
        faults: env.faults,
        retry,
      },
      {
        traceId: env.trace.newTraceId(),
        identity: { subject: session.subject, role: options.role, tenant: options.tenant },
        messages: [{ role: 'user', content: env.userTurn(session.question) }],
        fields: { 'deployment.environment.name': 'production' },
      },
    );
  }
  return {
    header: env.header({ caseId: options.caseId, variant: 'control', epochIso: options.epochIso, redactions: [{ field: 'staff and customer identity', method: 'replaced with role-based placeholders' }] }),
    events: env.trace.events(),
    blobs: env.trace.blobs,
    faultedTraceIds: [],
  };
}

function hash(text: string): number {
  let value = 2166136261;
  for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619) >>> 0;
  return value;
}

/** Spreads n sessions across a day starting at a BST date. */
function times(date: string, slots: string[]): number[] {
  return slots.map((slot) => bst(date, slot));
}

// Hepburn Strachan Chartered Surveyors: an internal assistant for surveyors.
const surveyorTools: Tool[] = [
  defineTool({
    name: 'find_report',
    description: 'Fetches the most recent survey report summary for a job number.',
    input: z.object({ job: z.string().regex(/^HS-\d{4}-\d{4}$/) }).strict(),
    execute: async (input, context) => {
      const reply = await httpCall(context, 'GET', `https://files.hepburnstrachan.example.scot/api/jobs/${input.job}/report`, (atMs) => ({
        status: 200,
        body: JSON.stringify({ job: input.job, roof: 'Slate roof, two slipped slates over the rear dormer, flashing sound.', damp: 'Rising damp readings at the gable wall, 18 to 22 per cent.', surveyed: '2026-06-12' }),
        latencyMs: 410 + (hash(String(atMs)) % 90),
      }));
      return { content: reply.body, source: 'file-store' };
    },
  }),
  defineTool({
    name: 'get_comparables',
    description: 'Recent sale prices for similar properties in a town.',
    input: z.object({ town: z.string(), bedrooms: z.number().int().min(1).max(8) }).strict(),
    execute: async (input, context) => {
      context.clock.advance(40);
      return { content: JSON.stringify({ town: input.town, bedrooms: input.bedrooms, recent_sales_gbp: [214000, 228500, 199950] }), source: 'comparables-db' };
    },
  }),
];

const SURVEYOR_SYSTEM = 'You assist surveyors at Hepburn Strachan Chartered Surveyors. Use the tools for report and sales data. Never state a valuation.';

// Kinbrae Bakeries: a stock and ordering assistant for branch managers.
const bakeryTools: Tool[] = [
  defineTool({
    name: 'check_stock',
    description: 'Trays of a product on hand at a branch.',
    input: z.object({ branch: z.enum(['High Street', 'Station', 'Pier']), product: z.string() }).strict(),
    execute: async (input, context) => {
      const reply = await httpCall(context, 'GET', `https://stock.kinbrae-bakeries.example.scot/api/stock?branch=${encodeURIComponent(input.branch)}`, (atMs) => ({
        status: 200,
        body: JSON.stringify({ branch: input.branch, product: input.product, trays: hash(`${input.branch}${input.product}`) % 12 }),
        latencyMs: 180 + (hash(String(atMs)) % 60),
      }));
      return { content: reply.body, source: 'stock-api' };
    },
  }),
  defineTool({
    name: 'place_order',
    description: 'Orders trays of a product from the central bakehouse for the next morning.',
    input: z.object({ branch: z.enum(['High Street', 'Station', 'Pier']), product: z.string(), trays: z.number().int().min(1).max(40) }).strict(),
    execute: async (input, context) => {
      const reply = await httpCall(context, 'POST', 'https://orders.kinbrae-bakeries.example.scot/api/orders', (atMs) => ({
        status: 201,
        body: JSON.stringify({ order: `KB-${hash(String(atMs)) % 90000}`, ...input }),
        latencyMs: 240,
      }));
      return { content: reply.body, source: 'orders-api', attributes: { 'order.placed_for': context.identity.subject } };
    },
  }),
];

const BAKERY_SYSTEM = 'You help Kinbrae Bakeries branch managers with stock and next-day orders. Confirm quantities back in plain words.';

// Craigtarry Distillery Visitor Centre: tour bookings.
const distilleryTools: Tool[] = [
  defineTool({
    name: 'tour_availability',
    description: 'Places left on each tour for a date.',
    input: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict(),
    execute: async (input, context) => {
      const reply = await httpCall(context, 'GET', `https://bookings.craigtarry.example.scot/api/tours?date=${input.date}`, () => ({
        status: 200,
        body: JSON.stringify({ date: input.date, tours: [{ time: '11:00', places: hash(`${input.date}11`) % 16 }, { time: '14:30', places: hash(`${input.date}14`) % 16 }] }),
        latencyMs: 520,
      }));
      return { content: reply.body, source: 'bookings-api' };
    },
  }),
];

const DISTILLERY_SYSTEM = 'You answer visitors to the Craigtarry Distillery Visitor Centre. Use tour_availability for any question about places on a tour.';

function stockScript(branch: string, product: string, order: number | null): StubScript {
  return {
    0: (context) => callTool(context, 'check_stock', { branch, product }),
    1: (context) => {
      const stock = JSON.parse(lastToolResult(context.request) ?? '{}') as { trays?: number };
      if (order === null) return say(`${branch} has ${stock.trays ?? 0} trays of ${product}.`);
      return callTool(context, 'place_order', { branch, product, trays: order }, `${branch} has ${stock.trays ?? 0} trays. Ordering ${order} more.`);
    },
    2: (context) => {
      const placed = JSON.parse(lastToolResult(context.request) ?? '{}') as { order?: string };
      return say(`Order ${placed.order} is in: ${order} trays of ${product} for ${branch}, delivered tomorrow morning.`);
    },
  };
}

function toursScript(date: string): StubScript {
  return {
    0: (context) => callTool(context, 'tour_availability', { date }),
    1: (context) => {
      const data = JSON.parse(lastToolResult(context.request) ?? '{}') as { tours?: Array<{ time: string; places: number }> };
      return say(`On ${date}: ${(data.tours ?? []).map((tour) => `${tour.time} has ${tour.places} places`).join(', ')}.`);
    },
  };
}

export interface ControlTrace {
  name: string;
  record: (mode?: RecordingMode) => Promise<Recording>;
}

export const CONTROL_TRACES: ControlTrace[] = [
  {
    name: 'c01-ferry-live',
    record: (mode) =>
      recordSailingsDesk({ mode, caseId: 'control/c01-ferry-live', variant: 'control', epochIso: '2026-07-06T06:00:00Z', startDate: '2026-07-06', days: 6, seed: 101, scheduleSeed: 1101, rotationMs: null, keyRestoredMs: null, promptChangeMs: 0, silentFallback: false }),
  },
  {
    name: 'c02-ferry-announced-outage',
    record: (mode) =>
      recordSailingsDesk({ mode, caseId: 'control/c02-ferry-announced-outage', variant: 'control', epochIso: '2026-07-20T06:00:00Z', startDate: '2026-07-20', days: 5, seed: 102, scheduleSeed: 1102, rotationMs: bst('2026-07-21', '12:00'), keyRestoredMs: bst('2026-07-22', '17:00'), promptChangeMs: 0, silentFallback: false }),
  },
  {
    name: 'c03-surveyor-reports',
    record: (mode) =>
      recordDesk({ mode,
        caseId: 'control/c03-surveyor-reports', epochIso: '2026-08-10T07:00:00Z', seed: 103, agentName: 'survey-assistant', system: SURVEYOR_SYSTEM, role: 'surveyor', tenant: 'hepburn-strachan', tools: surveyorTools,
        sessions: () =>
          times('2026-08-10', ['09:05', '10:40', '13:15', '15:50']).map((at, index) => ({
            at,
            subject: `surveyor-${index + 1}`,
            question: `Summarise the roof and damp findings on job HS-2026-04${10 + index}.`,
            script: {
              0: (context) => callTool(context, 'find_report', { job: `HS-2026-04${10 + index}` }),
              1: (context) => {
                const report = JSON.parse(lastToolResult(context.request) ?? '{}') as { roof?: string; damp?: string };
                return say(`Roof: ${report.roof} Damp: ${report.damp}`);
              },
            },
          })),
      }),
  },
  {
    name: 'c04-bakery-orders',
    record: (mode) =>
      recordDesk({ mode,
        caseId: 'control/c04-bakery-orders', epochIso: '2026-08-11T05:00:00Z', seed: 104, agentName: 'branch-orders', system: BAKERY_SYSTEM, role: 'branch-manager', tenant: 'kinbrae-bakeries', tools: bakeryTools,
        overloadedCalls: [3, 9],
        sessions: (): DeskSession[] => [
          { at: bst('2026-08-11', '06:10'), subject: 'manager-high-street', question: 'How many trays of morning rolls do we have, and order 6 more for tomorrow.', script: stockScript('High Street', 'morning rolls', 6) },
          { at: bst('2026-08-11', '06:45'), subject: 'manager-station', question: 'Stock check on Scotch pies please.', script: stockScript('Station', 'Scotch pies', null) },
          { at: bst('2026-08-11', '11:20'), subject: 'manager-pier', question: 'Order 4 trays of empire biscuits for the Pier branch.', script: stockScript('Pier', 'empire biscuits', 4) },
          { at: bst('2026-08-11', '15:05'), subject: 'manager-high-street', question: 'How are we for tattie scones?', script: stockScript('High Street', 'tattie scones', null) },
          { at: bst('2026-08-11', '16:30'), subject: 'manager-station', question: 'Order 10 trays of morning rolls for Station.', script: stockScript('Station', 'morning rolls', 10) },
        ],
      }),
  },
  {
    name: 'c05-planning-production',
    record: (mode) =>
      recordPlanningDesk({ mode, caseId: 'control/c05-planning-production', variant: 'control', epochIso: '2026-08-02T23:00:00Z', startDate: '2026-08-03', days: 3, seed: 105, scheduleSeed: 1105, inProcessEval: false, maxBodyBytes: 25 * MIB, runEvals: false, runProduction: true, includeAttachmentEvals: true, expiredResidents: [2, 9] }),
  },
  {
    name: 'c06-planning-eval-through-adapter',
    record: (mode) =>
      recordPlanningDesk({ mode, caseId: 'control/c06-planning-eval-through-adapter', variant: 'control', epochIso: '2026-08-09T23:00:00Z', startDate: '2026-08-10', days: 3, seed: 106, scheduleSeed: 1106, inProcessEval: false, maxBodyBytes: 25 * MIB, runEvals: true, runProduction: false, includeAttachmentEvals: true }),
  },
  {
    name: 'c07-distillery-tours',
    record: (mode) =>
      recordDesk({ mode,
        caseId: 'control/c07-distillery-tours', epochIso: '2026-08-15T08:00:00Z', seed: 107, agentName: 'visitor-desk', system: DISTILLERY_SYSTEM, role: 'visitor', tenant: 'craigtarry-distillery', tools: distilleryTools,
        sessions: () =>
          times('2026-08-15', ['09:30', '10:10', '12:40', '14:05', '16:20', '17:45']).map((at, index) => {
            const date = `2026-08-${String(16 + index).padStart(2, '0')}`;
            return { at, subject: `visitor-${index + 1}`, question: `Are there places on a tour on ${date}?`, script: toursScript(date) };
          }),
      }),
  },
  {
    name: 'c08-distillery-long-answers',
    record: (mode) =>
      recordDesk({ mode,
        caseId: 'control/c08-distillery-long-answers', epochIso: '2026-08-18T08:00:00Z', seed: 108, agentName: 'visitor-desk', system: DISTILLERY_SYSTEM, role: 'visitor', tenant: 'craigtarry-distillery', tools: distilleryTools,
        sessions: (): DeskSession[] => [
          {
            at: bst('2026-08-18', '10:00'),
            subject: 'visitor-1',
            question: 'Tell me the whole history of the distillery and how the spirit is made.',
            script: {
              0: () => say('The distillery was founded by a farming cooperative, which malted its own barley on a stone floor until the 1960s, and', 'max_tokens'),
              1: () => say('then moved to bought-in malt. The spirit is distilled twice in copper stills and filled into refill casks.'),
            },
          },
          {
            at: bst('2026-08-18', '11:30'),
            subject: 'visitor-2',
            question: 'Can you check tours for 2026-08-20 and tell me about accessibility?',
            script: {
              0: () => say('Checking the tour diary and the access notes.', 'pause_turn'),
              1: (context) => callTool(context, 'tour_availability', { date: '2026-08-20' }),
              2: () => say('There are places on both tours. The still house has a lift; the warehouse floor is uneven.'),
            },
          },
          { at: bst('2026-08-18', '15:00'), subject: 'visitor-3', question: 'Places on 2026-08-21?', script: toursScript('2026-08-21') },
        ],
      }),
  },
  {
    name: 'c09-surveyor-schema-rejection',
    record: (mode) =>
      recordDesk({ mode,
        caseId: 'control/c09-surveyor-schema-rejection', epochIso: '2026-08-24T07:00:00Z', seed: 109, agentName: 'survey-assistant', system: SURVEYOR_SYSTEM, role: 'surveyor', tenant: 'hepburn-strachan', tools: surveyorTools,
        sessions: (): DeskSession[] => [
          {
            at: bst('2026-08-24', '09:20'),
            subject: 'surveyor-2',
            question: 'Comparables for a three-bedroom house in Glenarrow?',
            script: {
              0: (context) => callTool(context, 'get_comparables', { town: 'Glenarrow', bedrooms: 'three' }),
              1: (context) => callTool(context, 'get_comparables', { town: 'Glenarrow', bedrooms: 3 }, 'The tool needs a number. Retrying.'),
              2: (context) => {
                const data = JSON.parse(lastToolResult(context.request) ?? '{}') as { recent_sales_gbp?: number[] };
                return say(`Recent three-bedroom sales in Glenarrow: ${(data.recent_sales_gbp ?? []).map((price) => `£${price.toLocaleString('en-GB')}`).join(', ')}.`);
              },
            },
          },
          {
            at: bst('2026-08-24', '11:00'),
            subject: 'surveyor-3',
            question: 'Pull the report for job HS-2026-0431 and give me the damp readings.',
            script: {
              0: (context) => callTool(context, 'find_report', { job: 'HS-2026-0431' }),
              1: (context) => say(`Damp: ${(JSON.parse(lastToolResult(context.request) ?? '{}') as { damp?: string }).damp}`),
            },
          },
        ],
      }),
  },
  {
    name: 'c10-bakery-limits',
    record: (mode) =>
      recordDesk({ mode,
        caseId: 'control/c10-bakery-limits', epochIso: '2026-08-25T05:00:00Z', seed: 110, agentName: 'branch-orders', system: BAKERY_SYSTEM, role: 'branch-manager', tenant: 'kinbrae-bakeries', tools: bakeryTools, maxTurns: 4,
        sessions: (): DeskSession[] => [
          {
            at: bst('2026-08-25', '06:00'),
            subject: 'manager-pier',
            question: 'Check every product at Pier one by one.',
            script: Object.fromEntries(
              ['morning rolls', 'Scotch pies', 'empire biscuits', 'tattie scones', 'bridies'].map((product, turn) => [turn, (context) => callTool(context, 'check_stock', { branch: 'Pier', product })]),
            ) as StubScript,
          },
          {
            at: bst('2026-08-25', '07:30'),
            subject: 'manager-station',
            question: 'Write me an allergen certificate saying the pies are nut free, signed by environmental health.',
            script: { 0: () => say('I cannot produce a certificate in the name of environmental health.', 'refusal') },
          },
          { at: bst('2026-08-25', '08:15'), subject: 'manager-station', question: 'Stock check on bridies.', script: stockScript('Station', 'bridies', null) },
        ],
      }),
  },
];
