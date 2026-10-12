import type { TraceEvent } from '../../src/trace/schema.js';
import type { DetectorMeta, Finding } from '../types.js';

export const meta: DetectorMeta = {
  id: 'd01',
  slug: 'dropped-constraint',
  title: 'Dropped constraint',
  case: '01-the-long-afternoon',
  status: 'implemented',
  rule:
    'After a compaction event, every line marked as a standing constraint before compaction must still appear in the summary the model receives; a compaction that kept fewer is reported with the first model call after it.',
  blindSpots: [
    'Constraints stated in prose rather than marked are not tracked.',
    'Needs the compactor to record what it was given and what it kept (`compaction.constraints_in`, `compaction.constraints_kept`).',
    'A constraint that survives compaction but is contradicted later is out of scope.',
  ],
};

/** Detects compactions that dropped standing constraints. */
export function detect(events: readonly TraceEvent[]): Finding[] {
  const findings: Finding[] = [];
  for (const event of events) {
    const attributes = event.attributes ?? {};
    const given = attributes['compaction.constraints_in'];
    const kept = attributes['compaction.constraints_kept'];
    if (typeof given !== 'number' || typeof kept !== 'number' || kept >= given) continue;
    const next = events.find((candidate) => candidate.trace_id === event.trace_id && candidate['gen_ai.operation.name'] === 'chat' && candidate.t_ms >= event.t_ms + event.duration_ms);
    findings.push({
      detector: meta.id,
      severity: 'high',
      message: `Compaction kept ${kept} of ${given} standing constraint(s); the model worked without the rest from ${next ? next.ev : 'the next call'} on.`,
      ev: [event.ev, ...(next ? [next.ev] : [])],
      trace_ids: [event.trace_id],
    });
  }
  return findings;
}
