import type { TraceEvent } from '../src/trace/schema.js';

export interface Finding {
  detector: string;
  severity: 'high' | 'medium' | 'low';
  message: string;
  /** Evidence: the events that support the finding, first one is the main exhibit. */
  ev: string[];
  /** Sessions the finding is about. Used by evals to score per session. */
  trace_ids: string[];
}

export interface DetectorMeta {
  /** d01 to d10, matching the case number. */
  id: string;
  slug: string;
  title: string;
  /** Case folder this detector was written for. */
  case: string;
  status: 'implemented' | 'skeleton';
  /** One sentence: what the detector checks. */
  rule: string;
  blindSpots: string[];
}

export type DetectFn = (events: readonly TraceEvent[]) => Finding[];

export interface Detector {
  meta: DetectorMeta;
  detect: DetectFn;
}
