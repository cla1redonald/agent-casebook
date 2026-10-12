import type { TraceEvent } from '../src/trace/schema.js';

let counter = 0;

/** Builds a valid trace event with sensible defaults, for detector unit tests. */
export function event(fields: Partial<TraceEvent> & { name: string }): TraceEvent {
  counter += 1;
  return {
    ev: `ev-${String(counter).padStart(3, '0')}`,
    t_ms: counter * 1000,
    duration_ms: 10,
    trace_id: 'trace-a',
    span_id: `span-${counter}`,
    'span.kind': 'internal',
    ...fields,
  };
}

export function resetEvents(): void {
  counter = 0;
}
