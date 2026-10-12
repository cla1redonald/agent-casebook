import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readTrace } from '../../src/trace/read.js';
import { repoRoot } from '../../src/util/root.js';
import { detect, meta } from './d02-unconfirmed-send.js';

const caseDir = join(repoRoot(), 'cases', meta.case);

describe(`${meta.id} ${meta.title}`, () => {
  it('is registered as a skeleton until its case is recorded', () => {
    expect(meta.status).toBe('skeleton');
    expect(detect([])).toEqual([]);
  });

  // Fails until implemented: there is no trace yet and detect() returns nothing.
  it.todo('fires on trace.jsonl', () => {
    expect(existsSync(join(caseDir, 'trace.jsonl'))).toBe(true);
    expect(detect(readTrace(join(caseDir, 'trace.jsonl')).events).length).toBeGreaterThan(0);
  });

  it.todo('is silent on sealed/trace.fixed.jsonl', () => {
    expect(detect(readTrace(join(caseDir, 'sealed', 'trace.fixed.jsonl')).events)).toEqual([]);
  });
});
