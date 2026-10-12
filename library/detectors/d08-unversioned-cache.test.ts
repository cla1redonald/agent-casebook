import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { readTrace } from '../../src/trace/read.js';
import { repoRoot } from '../../src/util/root.js';
import { event, resetEvents } from '../../test/helpers.js';
import { detect, meta } from './d08-unversioned-cache.js';

const root = repoRoot();
const caseDir = join(root, 'cases', meta.case);

describe('d08 unversioned cache on the live recordings', () => {
  it('fires on trace.jsonl', () => {
    const findings = detect(readTrace(join(caseDir, 'trace.jsonl')).events);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]?.message).toMatch(/written under policy terms-2026-04 while terms-2026-08 is in force/);
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

describe('d08 rules', () => {
  beforeEach(resetEvents);

  const hit = (attributes: Record<string, string | number | boolean>) => event({ name: 'cache lookup', attributes: { 'cache.hit': true, ...attributes } });

  it('reports a hit across a policy change, and one past its TTL', () => {
    expect(detect([hit({ 'cache.entry_policy_version': 'v1', 'policy.version': 'v2', 'cache.entry_age_ms': 86_400_000 })])[0]?.message).toMatch(/policy v1 while v2/);
    expect(detect([hit({ 'cache.entry_age_ms': 9 * 86_400_000, 'cache.ttl_ms': 7 * 86_400_000 })])[0]?.message).toMatch(/past its TTL/);
  });

  it('stays silent on fresh hits under the current policy, and on misses', () => {
    expect(detect([hit({ 'cache.entry_policy_version': 'v2', 'policy.version': 'v2', 'cache.entry_age_ms': 1000, 'cache.ttl_ms': 7 * 86_400_000 }), event({ name: 'cache lookup', attributes: { 'cache.hit': false } })])).toEqual([]);
  });
});
