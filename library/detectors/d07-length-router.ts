import type { TraceEvent } from '../../src/trace/schema.js';
import type { DetectorMeta, Finding } from '../types.js';

export const meta: DetectorMeta = {
  id: 'd07',
  slug: 'length-router',
  title: 'Length router',
  case: '07-the-wrong-door',
  status: 'implemented',
  rule:
    'If the chosen model is predicted better by input length than by the task label, the router is keyed on the wrong thing; specialist requests it sent to the smaller model are reported.',
  blindSpots: [
    'Needs task labels (`task.tier` or `task.difficulty`) and the router decision (`router.choice`, `router.input_chars`) in the trace.',
    'A router that is right for the wrong reason on this traffic mix passes: if every short request happens to be routine, length and label agree.',
    'Model size is ranked by name (haiku, sonnet, opus, fable); unfamiliar model names are ranked as equal and never reported.',
    'Needs at least two labels and two models in one sweep; a single-route trace says nothing.',
  ],
};

const SPECIALIST = new Set(['specialist', 'hard', 'complex', 'expert']);
const TIER_ORDER = ['haiku', 'sonnet', 'opus', 'fable'];

function rank(model: string): number {
  const index = TIER_ORDER.findIndex((tier) => model.includes(tier));
  return index < 0 ? -1 : index;
}

interface Decision {
  event: TraceEvent;
  model: string;
  chars: number;
  label: string;
}

function decisions(events: readonly TraceEvent[]): Decision[] {
  const out: Decision[] = [];
  for (const event of events) {
    const attributes = event.attributes ?? {};
    const model = attributes['router.choice'];
    const chars = attributes['router.input_chars'];
    const label = attributes['task.tier'] ?? attributes['task.difficulty'];
    if (typeof model === 'string' && typeof chars === 'number' && typeof label === 'string') out.push({ event, model, chars, label });
  }
  return out;
}

/** Accuracy of the best single length threshold at predicting the model. */
function lengthAccuracy(rows: readonly Decision[]): number {
  const models = [...new Set(rows.map((row) => row.model))];
  let best = 0;
  for (const threshold of [...new Set(rows.map((row) => row.chars))]) {
    for (const below of models) {
      for (const above of models) {
        const correct = rows.filter((row) => (row.chars < threshold ? below : above) === row.model).length;
        best = Math.max(best, correct / rows.length);
      }
    }
  }
  return best;
}

/** Accuracy of predicting the model from the label's most common model. */
function labelAccuracy(rows: readonly Decision[]): number {
  let correct = 0;
  for (const label of new Set(rows.map((row) => row.label))) {
    const group = rows.filter((row) => row.label === label);
    const counts = new Map<string, number>();
    for (const row of group) counts.set(row.model, (counts.get(row.model) ?? 0) + 1);
    correct += Math.max(...counts.values());
  }
  return correct / rows.length;
}

/** Detects a model router that follows input length rather than the task. */
export function detect(events: readonly TraceEvent[]): Finding[] {
  const rows = decisions(events);
  if (new Set(rows.map((row) => row.model)).size < 2 || new Set(rows.map((row) => row.label)).size < 2) return [];
  const byLength = lengthAccuracy(rows);
  const byLabel = labelAccuracy(rows);
  if (byLength <= byLabel) return [];
  const largest = Math.max(...rows.map((row) => rank(row.model)));
  const summary = `Model choice follows input length (${Math.round(byLength * 100)}% predicted by a length threshold) better than the task label (${Math.round(byLabel * 100)}%).`;
  return rows
    .filter((row) => SPECIALIST.has(row.label) && rank(row.model) >= 0 && rank(row.model) < largest)
    .map((row) => ({
      detector: meta.id,
      severity: 'high' as const,
      message: `${summary} This ${row.label} request (${row.chars} characters) went to ${row.model}, not the larger model.`,
      ev: [row.event.ev],
      trace_ids: [row.event.trace_id],
    }));
}
