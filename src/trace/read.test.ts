import { describe, expect, it } from 'vitest';
import { byTraceId, parseTrace, TraceParseError } from './read.js';

const EVENT = { ev: 'ev-001', t_ms: 0, duration_ms: 5, trace_id: 't1', span_id: 's1', name: 'chat m', 'span.kind': 'client', 'gen_ai.operation.name': 'chat' };

describe('parseTrace', () => {
  it('reads events with or without a header line', () => {
    const trace = parseTrace(`${JSON.stringify(EVENT)}\n\n${JSON.stringify({ ...EVENT, ev: 'ev-002', trace_id: 't2' })}\n`);
    expect(trace.header).toBeNull();
    expect(trace.events.map((e) => e.ev)).toEqual(['ev-001', 'ev-002']);
    expect([...byTraceId(trace.events).keys()]).toEqual(['t1', 't2']);
  });

  it('reports the line number of invalid JSON', () => {
    expect(() => parseTrace(`${JSON.stringify(EVENT)}\n{oops`, 'f.jsonl')).toThrow(/f.jsonl:2: not valid JSON/);
  });

  it('rejects events that break the format', () => {
    expect(() => parseTrace(JSON.stringify({ ...EVENT, ev: 'event-1' }))).toThrow(TraceParseError);
    expect(() => parseTrace(JSON.stringify({ ...EVENT, 'gen_ai.operation.name': 'think' }))).toThrow(/gen_ai.operation.name/);
  });

  it('rejects a malformed header', () => {
    expect(() => parseTrace(JSON.stringify({ kind: 'header', format: 'other' }))).toThrow(/bad header/);
  });
});
