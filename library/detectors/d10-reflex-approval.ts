import type { TraceEvent } from '../../src/trace/schema.js';
import type { DetectorMeta, Finding } from '../types.js';

export const meta: DetectorMeta = {
  id: 'd10',
  slug: 'reflex-approval',
  title: 'Reflex approval',
  case: '10-the-willing-hand',
  status: 'implemented',
  rule:
    'Approvals faster than a reading-time floor for the diff size, or approvals with open clarifying questions dismissed, are reported, with the count per hour.',
  blindSpots: [
    'Approvals given outside the traced tool are invisible.',
    'A careful reviewer who read the diff elsewhere first looks the same as a reflex approval.',
    'The floor (5 seconds plus 0.2 seconds a changed line) is a judgement, not a measurement of reading speed.',
  ],
};

export const FLOOR = { baseMs: 5_000, perLineMs: 200 };

/** Detects approvals given faster than a person could read the change. */
export function detect(events: readonly TraceEvent[]): Finding[] {
  const approvals = events.filter((event) => typeof event.attributes?.['approval.latency_ms'] === 'number' && event.attributes?.['approval.decision'] === 'approved');
  const flagged = approvals.flatMap((event) => {
    const attributes = event.attributes ?? {};
    const latency = Number(attributes['approval.latency_ms']);
    const lines = Number(attributes['approval.diff_lines'] ?? 1);
    const dismissed = Number(attributes['approval.questions_dismissed'] ?? 0);
    const floor = FLOOR.baseMs + lines * FLOOR.perLineMs;
    const fast = latency < floor;
    if (!fast && dismissed === 0) return [];
    return [{ event, latency, lines, dismissed, floor, fast }];
  });
  const perHour = new Map<number, number>();
  for (const item of flagged) {
    const hour = Math.floor(item.event.t_ms / 3_600_000);
    perHour.set(hour, (perHour.get(hour) ?? 0) + 1);
  }
  return flagged.map((item) => {
    const parts: string[] = [];
    if (item.fast) parts.push(`Approved ${item.lines}-line change in ${item.latency} ms, under the ${item.floor} ms reading floor.`);
    if (item.dismissed > 0) parts.push(`${item.dismissed} clarifying question(s) dismissed unanswered.`);
    parts.push(`${perHour.get(Math.floor(item.event.t_ms / 3_600_000)) ?? 1} such approval(s) in the same hour.`);
    return { detector: meta.id, severity: item.dismissed > 0 ? ('high' as const) : ('medium' as const), message: parts.join(' '), ev: [item.event.ev], trace_ids: [item.event.trace_id] };
  });
}
