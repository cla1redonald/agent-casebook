import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { readTrace } from '../../src/trace/read.js';
import { repoRoot } from '../../src/util/root.js';
import { event, resetEvents } from '../../test/helpers.js';
import { detect, meta } from './d01-dropped-constraint.js';

const root = repoRoot();
const caseDir = join(root, 'cases', meta.case);

describe('d01 dropped constraint on the live recordings', () => {
  it('fires on trace.jsonl', () => {
    const findings = detect(readTrace(join(caseDir, 'trace.jsonl')).events);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]?.message).toMatch(/kept 0 of 2 standing constraint/);
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

describe('d01 rules', () => {
  beforeEach(resetEvents);

  const compaction = (given: number, kept: number) => event({ name: 'compaction', attributes: { 'compaction.constraints_in': given, 'compaction.constraints_kept': kept } });
  const chat = () => event({ name: 'chat m', 'gen_ai.operation.name': 'chat' });

  it('reports a compaction that kept fewer constraints than it was given, with the next model call', () => {
    const dropped = compaction(2, 1);
    const next = chat();
    expect(detect([dropped, next])[0]?.ev).toEqual([dropped.ev, next.ev]);
  });

  it('stays silent when every constraint was kept, or nothing was recorded', () => {
    expect(detect([compaction(2, 2), chat(), event({ name: 'compaction' })])).toEqual([]);
  });
});
