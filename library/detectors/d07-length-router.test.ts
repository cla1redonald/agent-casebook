import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { readTrace } from '../../src/trace/read.js';
import { repoRoot } from '../../src/util/root.js';
import { event, resetEvents } from '../../test/helpers.js';
import { detect, meta } from './d07-length-router.js';

const root = repoRoot();
const caseDir = join(root, 'cases', meta.case);

describe('d07 length router on the live recordings', () => {
  it('fires on trace.jsonl', () => {
    const findings = detect(readTrace(join(caseDir, 'trace.jsonl')).events);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]?.message).toMatch(/follows input length/);
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

describe('d07 rules', () => {
  beforeEach(resetEvents);

  const route = (chars: number, tier: string, model: string, trace: string) =>
    event({ name: 'route request', trace_id: trace, attributes: { 'router.choice': model, 'router.input_chars': chars, 'task.tier': tier } });

  it('reports specialist requests sent to the smaller model when length predicts the choice', () => {
    const events = [
      route(40, 'specialist', 'claude-haiku-5-5', 't1'),
      route(50, 'specialist', 'claude-haiku-5-5', 't2'),
      route(320, 'routine', 'claude-sonnet-5-5', 't3'),
      route(30, 'routine', 'claude-haiku-5-5', 't4'),
      route(300, 'routine', 'claude-sonnet-5-5', 't5'),
    ];
    expect(detect(events).flatMap((finding) => finding.trace_ids)).toEqual(['t1', 't2']);
  });

  it('stays silent when the label predicts the model', () => {
    const events = [route(40, 'specialist', 'claude-sonnet-5-5', 't1'), route(320, 'routine', 'claude-haiku-5-5', 't2'), route(30, 'routine', 'claude-haiku-5-5', 't3')];
    expect(detect(events)).toEqual([]);
  });
});
