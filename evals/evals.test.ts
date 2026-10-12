import { describe, expect, it } from 'vitest';
import { DETECTORS } from '../library/detectors/index.js';
import { formatReport, loadCorpus, runEvals } from '../library/scoring.js';
import type { Detector } from '../library/types.js';
import { repoRoot } from '../src/util/root.js';

const corpus = loadCorpus(repoRoot());

function disable(id: string): Detector[] {
  return DETECTORS.map((detector) => (detector.meta.id === id ? { meta: detector.meta, detect: () => [] } : detector));
}

describe('evals', () => {
  const implementedIds = DETECTORS.filter((detector) => detector.meta.status === 'implemented').map((detector) => detector.meta.id);

  it('loads every recorded case, its fixed trace and ten control traces, all live', () => {
    const recorded = corpus.filter((file) => file.kind === 'incident');
    expect(recorded.length).toBe(implementedIds.length);
    expect(corpus.filter((file) => file.kind === 'fixed')).toHaveLength(recorded.length);
    expect(corpus.filter((file) => file.kind === 'control')).toHaveLength(10);
    expect(corpus.every((file) => file.recording === 'live')).toBe(true);
  });

  it('is green with the real library', () => {
    const report = runEvals(DETECTORS, corpus);
    expect(report.pass).toBe(true);
    for (const row of report.rows.filter((r) => r.status === 'implemented')) {
      expect(row.recall, row.id).toBeGreaterThanOrEqual(0.9);
      expect(row.controlFilesWithFindings, row.id).toBe(0);
    }
  });

  it.each(implementedIds)('goes red when %s is disabled (seeded fault)', (id) => {
    const report = runEvals(disable(id), corpus);
    expect(report.pass).toBe(false);
    const row = report.rows.find((r) => r.id === id);
    expect(row?.pass).toBe(false);
    expect(row?.reasons).toContain('silent on its own case trace');
    expect(formatReport(report, corpus)).toMatch(/Overall: RED/);
  });

  it('goes red when a detector fires on healthy traces (seeded fault)', () => {
    const noisy = DETECTORS.map((detector) =>
      detector.meta.id === 'd03'
        ? { meta: detector.meta, detect: (events: Parameters<Detector['detect']>[0]) => [...new Set(events.map((e) => e.trace_id))].map((traceId) => ({ detector: 'd03', severity: 'low' as const, message: 'everything', ev: [], trace_ids: [traceId] })) }
        : detector,
    );
    const row = runEvals(noisy, corpus).rows.find((r) => r.id === 'd03');
    expect(row?.pass).toBe(false);
    expect(row?.reasons.join(' ')).toMatch(/fires on the fixed trace/);
    expect(row?.reasons.join(' ')).toMatch(/control trace/);
  });
});
