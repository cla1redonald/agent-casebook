import type { TraceEvent } from '../../src/trace/schema.js';
import { median } from '../stats.js';
import type { DetectorMeta, Finding } from '../types.js';

export const meta: DetectorMeta = {
  id: 'd03',
  slug: 'silent-fallback',
  title: 'Silent fallback',
  case: '03-the-quiet-understudy',
  status: 'implemented',
  rule:
    'A tool span that reports no error while a client call beneath it failed, or whose data source changed from the one it normally uses, is a fallback nobody was told about.',
  blindSpots: [
    'Tools that do not record a `source` attribute and have no client span beneath them: nothing to compare.',
    'A fallback that lives outside the traced process (for example a CDN serving a stale page) leaves no failed child span.',
    'If the very first call in a file is already the fallback, that source becomes the baseline and the later switch back to live is reported instead.',
    'Tools that legitimately alternate sources (cache then origin) are reported unless the cache hit sets `error.type` or uses the same `source`.',
  ],
};

const BASELINE_WINDOW = 20;
const LATENCY_CLIFF = 0.1;

function toolName(event: TraceEvent): string {
  return event['gen_ai.tool.name'] ?? event.name;
}

function failed(child: TraceEvent): boolean {
  return (child['http.status'] ?? 0) >= 500 || child['error.type'] !== undefined;
}

/** Detects tool calls that fell back to another source without saying so. */
export function detect(events: readonly TraceEvent[]): Finding[] {
  const children = new Map<string, TraceEvent[]>();
  for (const event of events) {
    if (!event.parent_span_id) continue;
    children.set(event.parent_span_id, [...(children.get(event.parent_span_id) ?? []), event]);
  }

  const baselines = new Map<string, { source: string | undefined; durations: number[] }>();
  const findings: Finding[] = [];

  for (const tool of events) {
    if (tool['gen_ai.operation.name'] !== 'execute_tool') continue;
    // A tool span that admits an error is doing its job; it is neither a finding nor a baseline.
    if (tool['error.type'] !== undefined) continue;

    const name = toolName(tool);
    const baseline = baselines.get(name);
    const swallowed = (children.get(tool.span_id) ?? []).filter((child) => child['span.kind'] === 'client' && failed(child));
    const switched = baseline !== undefined && baseline.source !== undefined && tool.source !== undefined && tool.source !== baseline.source;

    if (swallowed.length > 0 || switched) {
      const parts: string[] = [];
      if (swallowed.length > 0) {
        const statuses = swallowed.map((child) => child['http.status'] ?? child['error.type']).join(', ');
        parts.push(`${name} reported success while its upstream call failed (${statuses}).`);
      }
      if (switched) parts.push(`Its data came from source "${tool.source}" instead of the usual "${baseline?.source}".`);
      const usual = baseline ? median(baseline.durations) : 0;
      if (usual > 0 && tool.duration_ms < usual * LATENCY_CLIFF) {
        parts.push(`Latency fell from a median of ${Math.round(usual)} ms to ${tool.duration_ms} ms.`);
      }
      findings.push({
        detector: meta.id,
        severity: 'high',
        message: parts.join(' '),
        ev: [tool.ev, ...swallowed.map((child) => child.ev)],
        trace_ids: [tool.trace_id],
      });
      continue;
    }

    if (!baseline) baselines.set(name, { source: tool.source, durations: [tool.duration_ms] });
    else baseline.durations = [...baseline.durations, tool.duration_ms].slice(-BASELINE_WINDOW);
  }
  return findings;
}
