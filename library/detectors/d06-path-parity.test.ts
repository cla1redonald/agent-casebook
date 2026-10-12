import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { readTrace } from '../../src/trace/read.js';
import { repoRoot } from '../../src/util/root.js';
import { event, resetEvents } from '../../test/helpers.js';
import { detect, meta } from './d06-path-parity.js';

const root = repoRoot();
const caseDir = join(root, 'cases', meta.case);

describe('d06 path parity on recorded traces', () => {
  it('fires on trace.jsonl', () => {
    const findings = detect(readTrace(join(caseDir, 'trace.jsonl')).events);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]?.message).toMatch(/no HTTP adapter span/);
    expect(findings[0]?.message).toMatch(/x-eval-user/);
    expect(findings[0]?.message).toMatch(/413/);
  });

  it('is silent on sealed/trace.fixed.jsonl', () => {
    expect(detect(readTrace(join(caseDir, 'sealed', 'trace.fixed.jsonl')).events)).toEqual([]);
  });

  it('is silent on every control trace, including the eval that goes through the adapter', () => {
    const dir = join(root, 'corpus', 'control');
    for (const name of readdirSync(dir).filter((file) => file.endsWith('.jsonl'))) {
      expect({ name, findings: detect(readTrace(join(dir, name)).events) }).toEqual({ name, findings: [] });
    }
  });
});

describe('d06 rules', () => {
  beforeEach(resetEvents);

  const production = (traceId: string) => [
    event({ name: 'POST /v1/ask', trace_id: traceId, 'span.kind': 'server', 'http.route': '/v1/ask', 'deployment.environment.name': 'production', attributes: { 'http.request.header_names': ['authorization', 'content-type'] } }),
  ];

  it('reports an eval trace with no adapter span', () => {
    const evalRoot = event({ name: 'eval suite/case', trace_id: 'e1', 'deployment.environment.name': 'eval' });
    const findings = detect([evalRoot, ...production('p1')]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'high', trace_ids: ['e1'], ev: [evalRoot.ev] });
  });

  it('reports an eval through the adapter that still sends a header production never sends', () => {
    const evalServer = event({ name: 'POST /v1/ask', trace_id: 'e1', 'span.kind': 'server', 'http.route': '/v1/ask', 'deployment.environment.name': 'eval', attributes: { 'http.request.header_names': ['authorization', 'x-skip-auth'] } });
    const findings = detect([evalServer, ...production('p1')]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'medium' });
    expect(findings[0]?.message).toMatch(/x-skip-auth/);
  });

  it('is silent when there are no eval traces at all', () => {
    expect(detect(production('p1'))).toEqual([]);
  });

  it('only checks the adapter span when the sweep has no production traces', () => {
    const evalServer = event({ name: 'POST /v1/ask', trace_id: 'e1', 'span.kind': 'server', 'http.route': '/v1/ask', 'deployment.environment.name': 'test', attributes: { 'http.request.header_names': ['x-anything'] } });
    expect(detect([evalServer])).toEqual([]);
  });
});
