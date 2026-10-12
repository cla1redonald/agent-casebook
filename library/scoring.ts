import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readTrace } from '../src/trace/read.js';
import type { Trace, TraceEvent } from '../src/trace/schema.js';
import { formatInterval, wilson, type Interval } from './stats.js';
import type { Detector } from './types.js';

export interface CorpusFile {
  label: string;
  kind: 'incident' | 'fixed' | 'control';
  /** Case folder for incident and fixed traces. */
  caseId?: string;
  events: TraceEvent[];
  /** From the trace header: live or stub. Unknown for headerless files. */
  recording: 'live' | 'stub' | 'unknown';
  model: string;
  sessions: Set<string>;
  /** Sessions where the case's fault was injected. Empty for fixed and control traces. */
  faulted: Set<string>;
}

/** Loads every recorded case (incident and fixed) and the control corpus. */
export function loadCorpus(root: string): CorpusFile[] {
  const files: CorpusFile[] = [];
  const casesDir = join(root, 'cases');
  for (const caseId of readdirSync(casesDir).filter((name) => /^\d{2}-/.test(name)).sort()) {
    const incidentPath = join(casesDir, caseId, 'trace.jsonl');
    if (!existsSync(incidentPath)) continue;
    const labelsPath = join(root, 'evals', 'labels', `${caseId}.json`);
    const labels = existsSync(labelsPath) ? (JSON.parse(readFileSync(labelsPath, 'utf8')) as { faulted_trace_ids: string[] }) : { faulted_trace_ids: [] };
    files.push(corpusFile(`cases/${caseId}/trace.jsonl`, 'incident', readTrace(incidentPath), new Set(labels.faulted_trace_ids), caseId));
    const fixedPath = join(casesDir, caseId, 'sealed', 'trace.fixed.jsonl');
    if (existsSync(fixedPath)) files.push(corpusFile(`cases/${caseId}/sealed/trace.fixed.jsonl`, 'fixed', readTrace(fixedPath), new Set(), caseId));
  }
  const controlDir = join(root, 'corpus', 'control');
  for (const name of readdirSync(controlDir).filter((file) => file.endsWith('.jsonl')).sort()) {
    files.push(corpusFile(`corpus/control/${name}`, 'control', readTrace(join(controlDir, name)), new Set()));
  }
  return files;
}

function corpusFile(label: string, kind: CorpusFile['kind'], trace: Trace, faulted: Set<string>, caseId?: string): CorpusFile {
  const { events, header } = trace;
  return {
    label,
    kind,
    ...(caseId ? { caseId } : {}),
    events,
    recording: header?.recording ?? 'unknown',
    model: header?.model ?? 'unknown',
    sessions: new Set(events.map((event) => event.trace_id)),
    faulted,
  };
}

/** "all live recordings on claude-haiku-5-5", or a count of each kind. */
export function describeCorpus(corpus: readonly CorpusFile[]): string {
  const live = corpus.filter((file) => file.recording === 'live');
  const stub = corpus.length - live.length;
  const models = [...new Set(live.map((file) => file.model))].join(', ');
  if (stub === 0) return `all live recordings on ${models}`;
  if (live.length === 0) return 'all stub recordings';
  return `${live.length} live recordings on ${models} and ${stub} stub recordings`;
}

export interface DetectorScore {
  id: string;
  title: string;
  caseId: string;
  status: Detector['meta']['status'];
  recorded: boolean;
  /** Findings on the case's own incident trace. */
  caseFindings: number;
  silentOnFixed: boolean;
  controlFiles: number;
  controlFilesWithFindings: number;
  /** Per-session counts across the whole corpus. */
  positives: number;
  truePositives: number;
  recall: number;
  recallInterval: Interval;
  negatives: number;
  falsePositives: number;
  falsePositiveRate: number;
  falsePositiveInterval: Interval;
  pass: boolean;
  reasons: string[];
}

export const THRESHOLDS = { minRecall: 0.9, maxControlFiles: 0 } as const;

/**
 * Scores one detector per session: a session counts as flagged when any finding names it.
 * Positives are the faulted sessions of the detector's own case; every other session in the
 * corpus (clean sessions of its case, its fixed trace, other cases, the control corpus) is a negative.
 */
export function scoreDetector(detector: Detector, corpus: readonly CorpusFile[]): DetectorScore {
  const { meta } = detector;
  let positives = 0;
  let truePositives = 0;
  let negatives = 0;
  let falsePositives = 0;
  let caseFindings = 0;
  let silentOnFixed = true;
  let controlFiles = 0;
  let controlFilesWithFindings = 0;
  let recorded = false;

  for (const file of corpus) {
    const findings = detector.detect(file.events);
    const flagged = new Set(findings.flatMap((finding) => finding.trace_ids));
    const own = file.caseId === meta.case;
    if (own && file.kind === 'incident') {
      recorded = true;
      caseFindings = findings.length;
    }
    if (own && file.kind === 'fixed' && findings.length > 0) silentOnFixed = false;
    if (file.kind === 'control') {
      controlFiles += 1;
      if (findings.length > 0) controlFilesWithFindings += 1;
    }
    for (const session of file.sessions) {
      const isPositive = own && file.kind === 'incident' && file.faulted.has(session);
      if (isPositive) {
        positives += 1;
        if (flagged.has(session)) truePositives += 1;
      } else {
        negatives += 1;
        if (flagged.has(session)) falsePositives += 1;
      }
    }
  }

  const recall = positives === 0 ? 0 : truePositives / positives;
  const reasons: string[] = [];
  if (meta.status === 'implemented') {
    if (!recorded) reasons.push('case has no recording');
    if (caseFindings === 0) reasons.push('silent on its own case trace');
    if (!silentOnFixed) reasons.push('fires on the fixed trace');
    if (recall < THRESHOLDS.minRecall) reasons.push(`recall ${recall.toFixed(2)} below ${THRESHOLDS.minRecall}`);
    if (controlFilesWithFindings > THRESHOLDS.maxControlFiles) reasons.push(`fires on ${controlFilesWithFindings} control trace(s)`);
  }
  return {
    id: meta.id,
    title: meta.title,
    caseId: meta.case,
    status: meta.status,
    recorded,
    caseFindings,
    silentOnFixed,
    controlFiles,
    controlFilesWithFindings,
    positives,
    truePositives,
    recall,
    recallInterval: wilson(truePositives, positives),
    negatives,
    falsePositives,
    falsePositiveRate: negatives === 0 ? 0 : falsePositives / negatives,
    falsePositiveInterval: wilson(falsePositives, negatives),
    pass: meta.status !== 'implemented' || reasons.length === 0,
    reasons,
  };
}

export interface EvalReport {
  rows: DetectorScore[];
  pass: boolean;
}

export function runEvals(detectors: readonly Detector[], corpus: readonly CorpusFile[]): EvalReport {
  const rows = detectors.map((detector) => scoreDetector(detector, corpus));
  return { rows, pass: rows.every((row) => row.pass) };
}

export function formatReport(report: EvalReport, corpus: readonly CorpusFile[]): string {
  const sessions = corpus.reduce((sum, file) => sum + file.sessions.size, 0);
  const lines = [
    `Detector evals over ${corpus.length} trace files and ${sessions} sessions (${describeCorpus(corpus)}).`,
    'Recall is per faulted session of the detector\'s own case; false positives are per session across every other session. Intervals are 95% Wilson.',
    '',
    'det  status       case trace   fixed    control   TP/P      recall [95% CI]      FP/N       FP rate [95% CI]       verdict',
  ];
  for (const row of report.rows) {
    if (row.status === 'skeleton') {
      lines.push(`${row.id}  skeleton     no reproducing recording; rule specified, test marked todo`);
      continue;
    }
    lines.push(
      [
        row.id.padEnd(4),
        row.status.padEnd(12),
        `${row.caseFindings} found`.padEnd(12),
        (row.silentOnFixed ? 'silent' : 'FIRES').padEnd(8),
        `${row.controlFilesWithFindings}/${row.controlFiles}`.padEnd(9),
        `${row.truePositives}/${row.positives}`.padEnd(9),
        `${row.recall.toFixed(2)} ${formatInterval(row.recallInterval)}`.padEnd(20),
        `${row.falsePositives}/${row.negatives}`.padEnd(10),
        `${row.falsePositiveRate.toFixed(3)} ${formatInterval(row.falsePositiveInterval, 3)}`.padEnd(22),
        row.pass ? 'GREEN' : `RED (${row.reasons.join('; ')})`,
      ].join(' '),
    );
  }
  lines.push('', report.pass ? 'Overall: GREEN' : 'Overall: RED');
  return lines.join('\n');
}
