/**
 * Case 7, The Wrong Door. Craigtarry Distillery Visitor Centre.
 *
 * One assistant serves two audiences: visitors on the website, and trade buyers on the trade
 * desk portal. A router picks a route per request. The small route is Haiku 5.5 with the visitor
 * tools only (tours and cafe); the large route is Sonnet 5.5 with the visitor tools plus the cask
 * register and the bond guidance. In the incident variant the router sends anything under 280
 * characters to the small route, so short specialist trade questions get the model with no trade
 * tools. In the fixed variant it routes on the task: trade questions take the large route.
 */
import { z } from 'zod';
import type { AgentConfig } from '../agent.js';
import { makeRouter } from '../components/router.js';
import { FaultPlan } from '../faults.js';
import { addDays, bst, makeEnv, type Recording, type RecordingMode } from '../scenario.js';
import { defineTool, type Tool } from '../tools.js';
import { ask, fnv } from './common.js';

export const CASE_ID = '07-the-wrong-door';
const EPOCH = '2026-08-31T23:00:00Z';
const START_DATE = '2026-09-01';
const DAYS = 14;
export const SMALL_MODEL = 'claude-haiku-5-5';
export const LARGE_MODEL = 'claude-sonnet-5-5';
const THRESHOLD = 280;

const CASKS: Record<number, { spirit: string; cask_type: string; filled: string; strength_abv: number; bulk_litres: number; warehouse: string }> = {
  102: { spirit: 'Craigtarry single malt', cask_type: 'first-fill bourbon barrel', filled: '2014-03-11', strength_abv: 57.8, bulk_litres: 182, warehouse: 'Warehouse 2, Craigtarry bond' },
  214: { spirit: 'Craigtarry single malt', cask_type: 'refill oloroso sherry butt', filled: '2011-11-02', strength_abv: 54.3, bulk_litres: 431, warehouse: 'Warehouse 1, Craigtarry bond' },
  377: { spirit: 'Craigtarry peated single malt', cask_type: 'refill hogshead', filled: '2016-06-20', strength_abv: 59.6, bulk_litres: 211, warehouse: 'Warehouse 3, Craigtarry bond' },
};

const BOND_GUIDANCE = {
  export_outside_uk:
    'A cask can leave bond for export under duty suspension only once the export declaration has been accepted and the electronic movement document has been submitted and validated. A draft movement document is not enough; the cask stays in bond until validation.',
  move_between_bonds: 'A cask can move between approved bonded warehouses under duty suspension with a validated movement document naming both warehouse approval numbers.',
  duty_paid_release: 'A cask released into duty-paid circulation in the UK pays spirits duty on the litres of pure alcohol at release, before it leaves bond.',
  cask_ownership: 'Private cask owners may keep a cask in the Craigtarry bond for an annual storage and insurance fee; the distillery holds it under its warehouse approval.',
} as const;

function visitorTools(): Tool[] {
  return [
    defineTool({
      name: 'tour_availability',
      description: 'Places left on each distillery tour for one date, with ages allowed.',
      input: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict(),
      execute: async (input, context) => {
        context.clock.advance(180);
        const tours = [
          { time: '11:00', name: 'Classic tour', places: fnv(`${input.date}11`) % 16, ages: 'all ages; under 18s with an adult, no tasting' },
          { time: '14:30', name: 'Warehouse tasting tour', places: fnv(`${input.date}14`) % 12, ages: '18 and over' },
        ];
        return { content: JSON.stringify({ date: input.date, tours }), source: 'bookings' };
      },
    }),
    defineTool({
      name: 'visitor_information',
      description: 'Opening hours, cafe hours, dogs, parking and accessibility at the visitor centre.',
      input: z.object({ topic: z.enum(['opening_hours', 'cafe', 'dogs', 'parking', 'accessibility']) }).strict(),
      execute: async (input, context) => {
        context.clock.advance(20);
        const text = {
          opening_hours: 'Visitor centre open 10:00 to 17:00 daily, last tour 14:30.',
          cafe: 'The Still Room cafe is open 10:00 to 16:30; lunch is served 12:00 to 15:00.',
          dogs: 'Dogs on leads are welcome in the shop, cafe terrace and garden, but not on tours.',
          parking: 'Free parking for cars and two coaches beside the visitor centre.',
          accessibility: 'The shop, cafe and still house have step-free access and a lift; the warehouse floor is uneven.',
        }[input.topic];
        return { content: text, source: 'visitor-information' };
      },
    }),
  ];
}

function tradeTools(): Tool[] {
  return [
    defineTool({
      name: 'cask_record',
      description: 'Register entry for one cask: spirit, cask type, fill date, strength and bulk litres, and where it is held in bond.',
      input: z.object({ cask: z.number().int() }).strict(),
      execute: async (input, context) => {
        context.clock.advance(140);
        const record = CASKS[input.cask];
        if (!record) return { content: `No cask ${input.cask} on the register.`, isError: true, errorType: 'not_found', source: 'cask-register' };
        return { content: JSON.stringify({ cask: input.cask, ...record, status: 'in bond' }), source: 'cask-register' };
      },
    }),
    defineTool({
      name: 'bond_guidance',
      description: 'The distillery guidance for movements of casks out of or between bonded warehouses.',
      input: z.object({ topic: z.enum(['export_outside_uk', 'move_between_bonds', 'duty_paid_release', 'cask_ownership']) }).strict(),
      execute: async (input, context) => {
        context.clock.advance(30);
        return { content: BOND_GUIDANCE[input.topic], source: 'bond-guidance' };
      },
    }),
  ];
}

const SMALL_SYSTEM =
  'You answer questions at the Craigtarry Distillery Visitor Centre. Use the tools for tour places and visitor information. Keep answers short and friendly.';
const LARGE_SYSTEM =
  'You answer visitors and trade buyers at the Craigtarry Distillery Visitor Centre. Use the tools for tour places and visitor information. ' +
  'For any question about a cask, bonded stock, strength or export paperwork, use cask_record and bond_guidance and answer only from them.';

const TRADE_QUESTIONS = [
  'Can cask 214 leave bond for Norway on an EMCS draft?',
  'What strength is cask 377 at the moment?',
  'Can we move cask 102 to a bond in Leith next month?',
  'Is cask 214 sherry or bourbon, and when was it filled?',
  'How many bulk litres are left in cask 377?',
  'If we take cask 102 duty paid, when is the duty due?',
  'Can a private buyer keep cask 214 in your bond for five years?',
];

const VISITOR_QUESTIONS = [
  'Hello, we are a family of five, two adults and three children aged 6, 9 and 13, visiting Perthshire next week and we would love to do a tour on Saturday 12 September. Do the children need to book, is the tour suitable for them, and is the cafe open afterwards for lunch? We also have a dog. Can it come with us?',
  'Hi there. My husband and I are coming up from Edinburgh for his birthday on Friday 11 September and wondered whether there is still space on the warehouse tasting tour that afternoon. He uses a wheelchair some days, so we would also like to know whether the tour is accessible and where we can park nearest the entrance.',
  'Good morning. We are a group of eight friends on a cycling holiday and we will pass the distillery around midday on Wednesday 9 September. Is there a tour we could join without booking, somewhere to leave the bikes, and could we get lunch in the cafe before we set off again towards Crieff?',
  'Hello, I am organising a day out for my parents, who are both in their eighties, on Thursday 10 September. Could you tell me which tour is the shorter and gentler of the two, whether there are many stairs, and what time the cafe stops serving lunch, as they like to eat early?',
  'What time does the cafe close today?',
  'Are dogs allowed in the shop?',
];

interface Session {
  at: number;
  question: string;
  channel: 'web-chat' | 'trade-portal';
  tier: 'routine' | 'specialist';
  person: string;
}

function schedule(): Session[] {
  const sessions: Session[] = [];
  let visitor = 0;
  let buyer = 0;
  for (let day = 0; day < DAYS; day++) {
    const date = addDays(START_DATE, day);
    const seed = fnv(date);
    for (let slot = 0; slot < 2; slot++) {
      const question = VISITOR_QUESTIONS[(seed >>> (slot * 4)) % VISITOR_QUESTIONS.length] ?? VISITOR_QUESTIONS[0] ?? '';
      sessions.push({ at: bst(date, slot === 0 ? '10:15' : '15:40'), question, channel: 'web-chat', tier: 'routine', person: `visitor-${++visitor}` });
    }
    const question = TRADE_QUESTIONS[day % TRADE_QUESTIONS.length] ?? TRADE_QUESTIONS[0] ?? '';
    sessions.push({ at: bst(date, '12:05'), question, channel: 'trade-portal', tier: 'specialist', person: `trade-buyer-${(buyer++ % 4) + 1}` });
  }
  return sessions.sort((a, b) => a.at - b.at);
}

export async function recordCase07(variant: 'incident' | 'fixed', mode: RecordingMode = { kind: 'stub' }): Promise<Recording> {
  const faults = variant === 'incident' ? new FaultPlan([{ name: 'router_by_length' }]) : FaultPlan.none();
  const env = makeEnv(EPOCH, 7_007, faults, mode);
  const sessions = schedule();
  const tiers = new Map(sessions.map((session) => [session.question, session.tier]));
  const router = makeRouter({ smallModel: SMALL_MODEL, largeModel: LARGE_MODEL, classify: (text) => tiers.get(text) ?? 'routine', lengthThreshold: THRESHOLD, clock: env.clock, faults });
  const faulted: string[] = [];
  for (const session of sessions) {
    env.clock.set(Math.max(session.at, env.clock.now()));
    const traceId = env.trace.newTraceId();
    // The router sees the customer's text, not the date stamp the front end adds.
    const routed = router([{ role: 'user', content: session.question }]);
    const large = routed === LARGE_MODEL;
    const span = env.trace.start('route request', 'internal', traceId, undefined, { 'deployment.environment.name': 'production' });
    env.clock.advance(2);
    env.trace.end(span, {
      attributes: {
        'router.rule': faults.active('router_by_length', env.clock.now()) ? `input_chars < ${THRESHOLD} -> small` : 'task.tier == specialist -> large',
        'router.input_chars': session.question.length,
        'router.choice': routed,
        'router.route': large ? 'large' : 'small',
        'task.channel': session.channel,
        'task.tier': session.tier,
      },
    });
    const config: AgentConfig = {
      name: 'visitor-desk',
      // Live and replay modes call the routed model; stub mode keeps its planning model.
      model: env.mode.kind === 'stub' ? env.model : routed,
      system: large ? LARGE_SYSTEM : SMALL_SYSTEM,
      tools: large ? [...visitorTools(), ...tradeTools()] : visitorTools(),
      maxTurns: 6,
      maxTokens: large ? 1024 : 400,
      client: env.client,
      clock: env.clock,
      trace: env.trace,
      faults: env.faults,
    };
    await ask(env, config, {
      traceId,
      identity: { subject: session.person, role: session.channel === 'trade-portal' ? 'trade-buyer' : 'visitor', tenant: 'craigtarry-distillery' },
      question: session.question,
      fields: { 'deployment.environment.name': 'production', attributes: { 'session.channel': session.channel, 'task.tier': session.tier, 'router.route': large ? 'large' : 'small' } },
    });
    if (session.tier === 'specialist' && !large) faulted.push(traceId);
  }
  return {
    header: env.header({
      caseId: CASE_ID,
      variant,
      epochIso: EPOCH,
      redactions: [{ field: 'visitor and buyer identity', method: 'replaced with sequential numbers' }],
      notes: [`Two models answer in this trace: ${SMALL_MODEL} on the small route and ${LARGE_MODEL} on the large route.`],
    }),
    events: env.trace.events(),
    blobs: env.trace.blobs,
    faultedTraceIds: faulted,
  };
}
