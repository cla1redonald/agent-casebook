import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { readTrace } from '../../src/trace/read.js';
import { repoRoot } from '../../src/util/root.js';
import { event, resetEvents } from '../../test/helpers.js';
import { detect, meta } from './d03-silent-fallback.js';

const root = repoRoot();
const caseDir = join(root, 'cases', meta.case);

describe('d03 silent fallback on recorded traces', () => {
  it('fires on trace.jsonl', () => {
    const findings = detect(readTrace(join(caseDir, 'trace.jsonl')).events);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]?.message).toMatch(/reported success while its upstream call failed \(503\)/);
    expect(findings[0]?.message).toMatch(/Latency fell/);
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

describe('d03 rules', () => {
  beforeEach(resetEvents);

  const tool = (source: string, duration: number, extra: Record<string, unknown> = {}) =>
    event({ name: 'execute_tool lookup', 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'lookup', source, duration_ms: duration, ...extra });

  it('reports a failed client call beneath an ok tool span', () => {
    const parent = tool('live', 900);
    const child = event({ name: 'GET /x', 'span.kind': 'client', parent_span_id: parent.span_id, 'http.status': 502 });
    const findings = detect([parent, child]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.ev).toEqual([parent.ev, child.ev]);
  });

  it('reports a source switch with no error, and the latency cliff', () => {
    const findings = detect([tool('live', 900), tool('live', 950), tool('cache', 5)]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/source "cache" instead of the usual "live"/);
    expect(findings[0]?.message).toMatch(/median of 925 ms to 5 ms/);
  });

  it('stays silent when the tool span admits the error', () => {
    const parent = tool('snapshot', 12, { 'error.type': 'upstream_unavailable' });
    const child = event({ name: 'GET /x', 'span.kind': 'client', parent_span_id: parent.span_id, 'http.status': 503 });
    expect(detect([tool('live', 900), parent, child])).toEqual([]);
  });

  it('ignores client 4xx responses, which are not upstream failures', () => {
    const parent = tool('live', 300);
    const child = event({ name: 'GET /x', 'span.kind': 'client', parent_span_id: parent.span_id, 'http.status': 404 });
    expect(detect([parent, child])).toEqual([]);
  });
});
