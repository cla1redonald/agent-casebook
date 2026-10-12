import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { readTrace } from '../../src/trace/read.js';
import { repoRoot } from '../../src/util/root.js';
import { event, resetEvents } from '../../test/helpers.js';
import { detect, meta } from './d10-reflex-approval.js';

const root = repoRoot();
const caseDir = join(root, 'cases', meta.case);

describe('d10 reflex approval on the live recordings', () => {
  it('fires on trace.jsonl', () => {
    const findings = detect(readTrace(join(caseDir, 'trace.jsonl')).events);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]?.message).toMatch(/under the \d+ ms reading floor/);
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

describe('d10 rules', () => {
  beforeEach(resetEvents);

  const approval = (latency: number, lines: number, dismissed = 0) =>
    event({ name: 'approval review', attributes: { 'approval.decision': 'approved', 'approval.latency_ms': latency, 'approval.diff_lines': lines, 'approval.questions_dismissed': dismissed } });

  it('reports an approval under the reading floor, and dismissed questions', () => {
    expect(detect([approval(400, 12)])[0]?.message).toMatch(/400 ms, under the 7400 ms reading floor/);
    expect(detect([approval(60_000, 12, 2)])[0]?.severity).toBe('high');
  });

  it('stays silent on a review that took long enough with questions answered', () => {
    expect(detect([approval(38_000, 12)])).toEqual([]);
  });
});
