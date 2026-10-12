/**
 * Runs every detector against its case trace, its fixed trace, the other recorded cases and
 * the control corpus, and prints true and false positives with Wilson intervals.
 * Exits 1 when any implemented detector misses its thresholds.
 */
import { DETECTORS } from '../library/detectors/index.js';
import { formatReport, loadCorpus, runEvals } from '../library/scoring.js';
import { repoRoot } from '../src/util/root.js';

const corpus = loadCorpus(repoRoot());
const report = runEvals(DETECTORS, corpus);
console.log(formatReport(report, corpus));
if (!report.pass) process.exit(1);
