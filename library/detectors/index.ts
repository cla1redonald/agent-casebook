import type { Detector } from '../types.js';
import * as d01 from './d01-dropped-constraint.js';
import * as d02 from './d02-unconfirmed-send.js';
import * as d03 from './d03-silent-fallback.js';
import * as d04 from './d04-retry-storm.js';
import * as d05 from './d05-unit-drift.js';
import * as d06 from './d06-path-parity.js';
import * as d07 from './d07-length-router.js';
import * as d08 from './d08-unversioned-cache.js';
import * as d09 from './d09-silent-empty-listing.js';
import * as d10 from './d10-reflex-approval.js';

export const DETECTORS: Detector[] = [d01, d02, d03, d04, d05, d06, d07, d08, d09, d10].map((module) => ({
  meta: module.meta,
  detect: module.detect,
}));

export function implemented(detectors: readonly Detector[] = DETECTORS): Detector[] {
  return detectors.filter((detector) => detector.meta.status === 'implemented');
}
