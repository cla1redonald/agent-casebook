import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { readTrace } from '../../src/trace/read.js';
import { repoRoot } from '../../src/util/root.js';
import { event, resetEvents } from '../../test/helpers.js';
import { detect, meta } from './d04-retry-storm.js';

const root = repoRoot();
const caseDir = join(root, 'cases', meta.case);

describe('d04 retry storm on the live recordings', () => {
  it('fires on trace.jsonl', () => {
    const findings = detect(readTrace(join(caseDir, 'trace.jsonl')).events);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]?.message).toMatch(/consecutive failed model calls with gaps under 50 ms/);
  });

  it('is silent on sealed/trace.fixed.jsonl', () => {
    expect(detect(readTrace(join(caseDir, 'sealed', 'trace.fixed.jsonl')).events)).toEqual([]);
  });

  it('is silent on every control trace', () => {
    const dir = join(root, 'corpus', 'control');
    for (const name of readdirSync(dir).filter((file) => file.endsWith('.jsonl'))) {
      expect({ name, findings: detect(readTrace(join(dir, name)).events) }).toEqual({ name, findings: [] });
    }
  });
});

describe('d04 rules', () => {
  beforeEach(resetEvents);

  const chat = (start: number, duration: number, failed: boolean, trace = 'trace-a') =>
    event({ name: 'chat m', 'gen_ai.operation.name': 'chat', t_ms: start, duration_ms: duration, trace_id: trace, ...(failed ? { 'error.type': '429' } : {}) });

  it('reports three failed calls retried at once, and the second layer beneath them', () => {
    const calls = [chat(0, 20, true), chat(25, 20, true), chat(50, 20, true)];
    const http = calls.flatMap((call) => [1, 2].map(() => event({ name: 'POST /v1/messages', 'span.kind': 'client', parent_span_id: call.span_id, 'http.request.body.size': 900 })));
    const findings = detect([...calls, ...http]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/two retry layers/);
    expect(findings[0]?.message).toMatch(/same 900-byte request/);
  });

  it('stays silent on retries with backoff', () => {
    expect(detect([chat(0, 20, true), chat(600, 20, true), chat(2_000, 20, true), chat(6_000, 900, false)])).toEqual([]);
  });

  it('needs three in a row', () => {
    expect(detect([chat(0, 20, true), chat(25, 20, true), chat(50, 900, false)])).toEqual([]);
  });
});
