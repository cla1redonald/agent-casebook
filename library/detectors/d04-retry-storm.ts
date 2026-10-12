import type { TraceEvent } from '../../src/trace/schema.js';
import { byTraceId } from '../../src/trace/read.js';
import type { DetectorMeta, Finding } from '../types.js';

export const meta: DetectorMeta = {
  id: 'd04',
  slug: 'retry-storm',
  title: 'Retry storm',
  case: '04-the-eleven-thousand-knocks',
  status: 'implemented',
  rule:
    'Three or more consecutive failed model calls in one session with gaps under 50 ms are retries without backoff; HTTP attempts beneath each failed call show a second retry layer multiplying them.',
  blindSpots: [
    'Retries made by an SDK beneath the traced client are invisible unless the SDK, or a proxy, records its own HTTP attempts.',
    'A storm spread across many sessions with one attempt each needs a cross-session window, which this does not have.',
    'Retries after a fixed short pause (say 100 ms) are not near-zero but are still too fast; the 50 ms gap is a threshold, not a principle.',
  ],
};

const GAP_MS = 50;
const MIN_RUN = 3;

/** Detects failed model calls retried at once, again and again. */
export function detect(events: readonly TraceEvent[]): Finding[] {
  const children = new Map<string, TraceEvent[]>();
  for (const event of events) if (event.parent_span_id) children.set(event.parent_span_id, [...(children.get(event.parent_span_id) ?? []), event]);
  const findings: Finding[] = [];
  for (const session of byTraceId(events).values()) {
    const chats = session.filter((event) => event['gen_ai.operation.name'] === 'chat').sort((a, b) => a.t_ms - b.t_ms);
    let run: TraceEvent[] = [];
    let longest: TraceEvent[] = [];
    let fastFailures = 0;
    for (const chat of chats) {
      const previous = run[run.length - 1];
      const failed = chat['error.type'] !== undefined;
      const quick = previous !== undefined && chat.t_ms - (previous.t_ms + previous.duration_ms) < GAP_MS;
      if (failed && (run.length === 0 || quick)) run.push(chat);
      else run = failed ? [chat] : [];
      if (run.length > longest.length) longest = [...run];
      if (failed && quick) fastFailures += 1;
    }
    if (longest.length < MIN_RUN) continue;
    const attempts = longest.map((chat) => (children.get(chat.span_id) ?? []).filter((child) => child['span.kind'] === 'client').length);
    const layered = attempts.some((count) => count > 1);
    const sizes = new Set(longest.flatMap((chat) => (children.get(chat.span_id) ?? []).map((child) => child['http.request.body.size']).filter((size) => size !== undefined)));
    const parts = [`${longest.length} consecutive failed model calls with gaps under ${GAP_MS} ms (${fastFailures} near-zero retries in this session).`];
    if (layered) parts.push(`Each failed call made up to ${Math.max(...attempts)} HTTP attempts beneath it: two retry layers multiply.`);
    if (sizes.size === 1) parts.push(`Every attempt resent the same ${[...sizes][0]}-byte request.`);
    findings.push({ detector: meta.id, severity: 'high', message: parts.join(' '), ev: longest.map((chat) => chat.ev).slice(0, 12), trace_ids: [longest[0]?.trace_id ?? ''] });
  }
  return findings;
}
