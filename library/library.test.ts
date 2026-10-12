import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../src/util/root.js';
import { DETECTORS, implemented } from './detectors/index.js';
import { median, wilson } from './stats.js';

describe('detector registry', () => {
  it('has one detector per case, d01 to d10, each with a file named after its slug', () => {
    expect(DETECTORS.map((detector) => detector.meta.id)).toEqual(['d01', 'd02', 'd03', 'd04', 'd05', 'd06', 'd07', 'd08', 'd09', 'd10']);
    for (const { meta } of DETECTORS) {
      expect(existsSync(join(repoRoot(), 'library', 'detectors', `${meta.id}-${meta.slug}.ts`))).toBe(true);
      expect(existsSync(join(repoRoot(), 'cases', meta.case, 'case.yaml'))).toBe(true);
      expect(meta.blindSpots.length).toBeGreaterThan(0);
    }
  });

  it('implements every detector whose case reproduced live, and leaves d02 as a skeleton', () => {
    expect(implemented().map((detector) => detector.meta.id)).toEqual(['d01', 'd03', 'd04', 'd05', 'd06', 'd07', 'd08', 'd09', 'd10']);
  });
});

describe('stats', () => {
  it('computes the Wilson interval', () => {
    const interval = wilson(58, 58);
    expect(interval.high).toBeCloseTo(1, 10);
    expect(interval.low).toBeCloseTo(0.938, 3);
    const half = wilson(5, 10);
    expect(half.low).toBeCloseTo(0.237, 3);
    expect(half.high).toBeCloseTo(0.763, 3);
    expect(wilson(0, 0)).toEqual({ low: 0, high: 1 });
  });

  it('computes a median', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});
