/**
 * Case 1, The Long Afternoon. Hepburn Strachan Chartered Surveyors.
 *
 * One drafting session, open all day on one job. The surveyor pastes the instruction letter,
 * then drafts the report section by section; the assistant reads the site notes for each section.
 * When the conversation passes its budget the harness compacts the older messages into a summary.
 * In the incident variant the summary keeps the job's facts and drops the letter's standing
 * constraint (no market value in the report); in the fixed variant constraints are carried into
 * the summary word for word.
 *
 * Reduced size: the incident in the scene ran to about 140,000 tokens. To fit the cheap recording
 * option this recording peaks at about 60,000, and the header and README say so.
 */
import { z } from 'zod';
import { runAgent, type AgentConfig } from '../agent.js';
import { textOf, type Message } from '../client.js';
import { compact } from '../components/compaction.js';
import { FaultPlan } from '../faults.js';
import { bst, makeEnv, type Recording, type RecordingMode } from '../scenario.js';
import { estimateTokens } from '../stub.js';
import { defineTool, type Tool } from '../tools.js';
import { fnv } from './common.js';

export const CASE_ID = '01-the-long-afternoon';
const EPOCH = '2026-10-06T23:00:00Z';
const DATE = '2026-10-07';
/** Compact when the conversation passes this estimate (four characters a token; about 60,000 real tokens). */
export const COMPACTION_BUDGET_TOKENS = 45_000;
/** User turns kept verbatim after a compaction. */
const KEEP_TURNS = 2;
export const REDUCED_CONTEXT_NOTE =
  'Reduced context: the session in the scene ran to about 140,000 tokens; this recording peaks at about 60,000 so that it fits the cheap recording option. The compaction budget is scaled to match.';

export const INSTRUCTION_LETTER = [
  'Hepburn Strachan Chartered Surveyors: instruction letter (residential condition survey)',
  'Fact: Client: Mr and Mrs Lennox.',
  'Fact: Property: 14 Kirkgate, Dunmore. A 1930s semi-detached house, three bedrooms, rendered cavity walls, slate roof with a rear dormer.',
  'Fact: Inspection: Wednesday 7 October 2026, by the assistant surveyor.',
  'Fact: Report type: condition report, sections for each element, with a summary section for the client.',
  'Constraint: The report must not state a market value or any valuation figure. Valuations are issued separately and signed by a registered valuer.',
  'Constraint: Do not give an opinion on the asking price or on whether the client should buy.',
  'Fact: The client will read the summary section first.',
].join('\n');

const SECTIONS = ['roof', 'chimney and dormer', 'external walls', 'damp', 'windows and doors', 'services', 'interior', 'garden and boundaries', 'outbuildings', 'drainage', 'insulation and energy', 'location and local market'] as const;
type Section = (typeof SECTIONS)[number];

const ELEMENTS: Record<Section, string[]> = {
  roof: ['slates', 'ridge tiles', 'valley gutter', 'lead flashings', 'sarking boards', 'roof void timbers', 'felt underlay'],
  'chimney and dormer': ['chimney stack', 'flaunching', 'chimney pots', 'dormer cheeks', 'dormer roof', 'dormer window', 'lead aprons'],
  'external walls': ['front roughcast', 'gable render', 'rear render', 'base course', 'window cills', 'wall heads', 'party wall line'],
  damp: ['gable wall at skirting', 'hall floor', 'under-stair cupboard', 'rear kitchen wall', 'front bedroom chimney breast', 'bathroom ceiling', 'sub-floor vents'],
  'windows and doors': ['front bay windows', 'rear kitchen window', 'bedroom casements', 'dormer window', 'front door', 'back door', 'patio screen'],
  services: ['consumer unit', 'wiring', 'gas boiler', 'hot water cylinder', 'radiators', 'cold water main', 'smoke alarms'],
  interior: ['hall ceiling', 'living room cornice', 'stair balustrade', 'kitchen floor', 'bedroom ceilings', 'bathroom tiling', 'loft hatch'],
  'garden and boundaries': ['front boundary wall', 'rear fence', 'gate', 'paths', 'patio', 'retaining wall', 'trees near the house'],
  outbuildings: ['detached garage roof', 'garage walls', 'garage door', 'timber shed', 'shed floor', 'greenhouse', 'oil tank base'],
  drainage: ['inspection chamber', 'rainwater pipes', 'gutters', 'gully at back door', 'soil and vent pipe', 'surface water run-off', 'shared drain'],
  'insulation and energy': ['loft insulation', 'cavity fill', 'window glazing', 'boiler efficiency', 'draught stripping', 'hot water insulation', 'energy rating'],
  'location and local market': ['street', 'parking', 'flood map', 'mining records', 'conservation status', 'local amenities', 'recent sales'],
};

const CONDITIONS = [
  'in fair condition for its age, with no action needed at present',
  'showing wear consistent with age; monitor and repair as part of normal maintenance',
  'in poor condition; repair within the next year is advised',
  'defective; prompt repair by a competent contractor is advised',
  'in good condition, with no defects seen',
];

/** Long site notes for a section: what the surveyor recorded, element by element, about 18,000 characters. */
export function siteNotes(section: Section): string {
  const lines: string[] = [`Site notes: ${section}. 14 Kirkgate, Dunmore. Inspected 7 October 2026.`];
  const elements = ELEMENTS[section];
  for (let pass = 0; pass < 22; pass++) {
    for (const element of elements) {
      const seed = fnv(`${section}|${element}|${pass}`);
      const condition = CONDITIONS[seed % CONDITIONS.length] ?? CONDITIONS[0];
      const position = ['front', 'rear', 'left-hand', 'right-hand', 'upper', 'lower'][(seed >>> 4) % 6];
      const detail = [
        `moisture reading ${10 + (seed % 14)} per cent`,
        `crack width under ${1 + (seed % 3)} mm`,
        `photographed as image ${100 + (seed % 400)}`,
        'viewed from ground level with binoculars',
        'access limited by stored items',
        'checked against the previous owner\'s maintenance records',
      ][(seed >>> 8) % 6];
      lines.push(`- ${element} (${position}, observation ${pass + 1}): ${condition}; ${detail}.`);
    }
  }
  const facts: Record<Section, string[]> = {
    roof: ['Fact: Roof: two slipped slates over the rear dormer; flashings sound.'],
    'chimney and dormer': ['Fact: Chimney: flaunching cracked; dormer cheeks sound.'],
    'external walls': ['Fact: Walls: hairline cracking to the front roughcast below the bay, not progressive.'],
    damp: ['Fact: Damp: readings of 18 to 22 per cent at the gable wall at skirting level.'],
    'windows and doors': ['Fact: Windows: rear kitchen window frame decayed at the cill.'],
    services: ['Fact: Services: boiler 14 years old; consumer unit modern; no gas safety record seen.'],
    interior: ['Fact: Interior: bathroom ceiling stained under the dormer.'],
    'garden and boundaries': ['Fact: Boundaries: rear fence leaning; front wall sound.'],
    outbuildings: ['Fact: Garage: roof sheets may contain asbestos; do not disturb.'],
    drainage: ['Fact: Drainage: gully at the back door partly blocked.'],
    'insulation and energy': ['Fact: Energy: loft insulation 100 mm; recommend 270 mm.'],
    'location and local market': ['Fact: Recent sales of similar houses on Kirkgate: £238,000 (March 2026) and £251,500 (June 2026).'],
  };
  return [...lines, ...facts[section]].join('\n');
}

function tools(): Tool[] {
  return [
    defineTool({
      name: 'get_site_notes',
      description: "The surveyor's site notes for one section of the report, element by element.",
      input: z.object({ section: z.enum(SECTIONS) }).strict(),
      execute: async (input, context) => {
        context.clock.advance(90);
        return { content: siteNotes(input.section), source: 'site-notes' };
      },
    }),
  ];
}

const SYSTEM =
  'You are the report drafting assistant at Hepburn Strachan Chartered Surveyors. You help a surveyor draft a residential condition report section by section, ' +
  'in plain British English, from the instruction letter, the site notes and the surveyor\'s requests. Read the site notes with get_site_notes before drafting a section. ' +
  'Follow the instruction letter. Each section should be about 150 words.';

interface Turn {
  time: string;
  text: string;
}

const TURNS: Turn[] = [
  { time: '08:45', text: `Here is the instruction letter for today's job.\n\n${INSTRUCTION_LETTER}\n\nPlease confirm you have it, in one sentence.` },
  { time: '09:05', text: 'Draft the roof section.' },
  { time: '09:40', text: 'Draft the chimney and dormer section.' },
  { time: '10:10', text: 'Draft the external walls section.' },
  { time: '10:45', text: 'Draft the damp section.' },
  { time: '11:20', text: 'Draft the windows and doors section.' },
  { time: '11:55', text: 'Draft the services section.' },
  { time: '12:30', text: 'Draft the interior section.' },
  { time: '13:30', text: 'Draft the garden and boundaries section.' },
  { time: '13:55', text: 'Draft the outbuildings section.' },
  { time: '14:20', text: 'Draft the drainage section.' },
  { time: '14:45', text: 'Draft the insulation and energy section.' },
  { time: '15:05', text: 'Draft the location section, using the location and local market notes.' },
  { time: '15:30', text: 'Now draft the summary section, the one the client reads first. Write it as a client would want it: overall condition, what needs doing first, and where the house stands overall.' },
];

/** Index of the first message of the turn that starts `keep` turns from the end. */
function turnBoundary(messages: readonly Message[], keep: number): number {
  const starts = messages.flatMap((message, index) => (message.role === 'user' && typeof message.content === 'string' ? [index] : []));
  return starts[Math.max(0, starts.length - keep)] ?? 0;
}

export async function recordCase01(variant: 'incident' | 'fixed', mode: RecordingMode = { kind: 'stub' }): Promise<Recording> {
  const faults = variant === 'incident' ? new FaultPlan([{ name: 'context_overflow_compaction_drop' }]) : FaultPlan.none();
  const env = makeEnv(EPOCH, 1_001, faults, mode);
  const traceId = env.trace.newTraceId();
  const config: AgentConfig = {
    name: 'report-drafter',
    model: env.model,
    system: SYSTEM,
    tools: tools(),
    maxTurns: 4,
    maxTokens: 1200,
    client: env.client,
    clock: env.clock,
    trace: env.trace,
    faults: env.faults,
  };
  const identity = { subject: 'assistant-surveyor', role: 'surveyor', tenant: 'hepburn-strachan' };
  let history: Message[] = [];
  let droppedConstraint = false;
  for (const turn of TURNS) {
    env.clock.set(Math.max(bst(DATE, turn.time), env.clock.now()));
    const tokens = estimateTokens(JSON.stringify(history));
    if (tokens > COMPACTION_BUDGET_TOKENS) {
      const span = env.trace.start('compaction', 'internal', traceId, undefined, { 'deployment.environment.name': 'production' });
      const cut = turnBoundary(history, KEEP_TURNS);
      const older = history.slice(0, cut);
      const constraintsIn = older.flatMap((message) => textOf(message.content).split('\n')).filter((line) => /^constraint:/i.test(line.trim())).length;
      const result = compact(history, { keepRecent: history.length - cut, faults, atMs: env.clock.now() });
      env.clock.advance(1_800);
      const summary = result.messages[0] ? textOf(result.messages[0].content) : '';
      const constraintsKept = summary.split('\n').filter((line) => /constraint:/i.test(line)).length;
      if (constraintsKept < constraintsIn) droppedConstraint = true;
      history = result.messages;
      env.trace.end(span, {
        attributes: {
          'compaction.tokens_before_estimate': tokens,
          'compaction.tokens_after_estimate': estimateTokens(JSON.stringify(history)),
          'compaction.messages_replaced': older.length,
          'compaction.constraints_in': constraintsIn,
          'compaction.constraints_kept': constraintsKept,
          'compaction.facts_kept': summary.split('\n').filter((line) => /fact:/i.test(line)).length,
        },
        ...env.trace.content(summary),
      });
    }
    const result = await runAgent(config, {
      traceId,
      identity,
      messages: [...history, { role: 'user', content: env.userTurn(turn.text) }],
      fields: { 'deployment.environment.name': 'production', attributes: { 'job.reference': 'HS-2026-0433', 'session.channel': 'desktop' } },
    });
    history = result.messages;
  }
  return {
    header: env.header({
      caseId: CASE_ID,
      variant,
      epochIso: EPOCH,
      redactions: [{ field: 'staff and client identity', method: 'invented names and roles' }],
      notes: [REDUCED_CONTEXT_NOTE],
    }),
    events: env.trace.events(),
    blobs: env.trace.blobs,
    faultedTraceIds: variant === 'incident' && droppedConstraint ? [traceId] : [],
  };
}
