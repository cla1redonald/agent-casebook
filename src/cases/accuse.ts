import { readFileSync } from 'node:fs';
import { readTrace } from '../trace/read.js';
import type { LoadedCase } from './load.js';
import { redHerringHash, unseal, verdictHash } from './seal.js';
import { splitSolution, type SolutionFrontMatter } from './solution.js';

export interface Accusation {
  suspect: string;
  cite: string[];
  /** The cheapest test that would falsify the accusation. Required, not scored. */
  test: string;
}

export type Outcome = 'solved' | 'weak-citations' | 'red-herring' | 'wrong-suspect';

export interface Judgement {
  outcome: Outcome;
  unknownCitations: string[];
  /** Share of cited ids that belong to the cracking evidence. Only known for the right suspect. */
  precision: number | null;
  /** Share of cracking evidence groups the citations touch. Only known for the right suspect. */
  recall: number | null;
  groupsHit: number | null;
  groupsTotal: number | null;
  solution: { front: SolutionFrontMatter; body: string } | null;
}

export const MIN_TEST_LENGTH = 15;
export const MIN_PRECISION = 0.5;
/** Cracking groups that must be cited, capped at the number of groups. */
export const MIN_GROUPS = 2;

export class AccusationError extends Error {}

/** Checks an accusation is well formed before it counts as an attempt. */
export function validate(loaded: LoadedCase, accusation: Accusation): void {
  if (loaded.file.status !== 'recorded' || !loaded.tracePath) {
    throw new AccusationError(`${loaded.file.title} has no recording yet. \`casebook open ${loaded.file.number}\` shows the scene and says why.`);
  }
  if (!loaded.file.suspects.includes(accusation.suspect)) {
    throw new AccusationError(`"${accusation.suspect}" is not in this line-up. Suspects: ${loaded.file.suspects.join(', ')}.`);
  }
  if (accusation.cite.length === 0) throw new AccusationError('Cite at least one event id, for example --cite ev-014,ev-022.');
  if (accusation.test.trim().length < MIN_TEST_LENGTH) {
    throw new AccusationError(`--test must describe the cheapest test that would prove you wrong (at least ${MIN_TEST_LENGTH} characters).`);
  }
}

export function judge(loaded: LoadedCase, accusation: Accusation): Judgement {
  validate(loaded, accusation);
  const caseId = loaded.file.id;
  const known = new Set(readTrace(loaded.tracePath as string).events.map((event) => event.ev));
  const cited = [...new Set(accusation.cite.map((id) => id.trim().toLowerCase()).filter(Boolean))];
  const unknownCitations = cited.filter((id) => !known.has(id));
  const blank = { unknownCitations, precision: null, recall: null, groupsHit: null, groupsTotal: null, solution: null };

  if (verdictHash(caseId, accusation.suspect) !== loaded.file.verdict.sha256) {
    const outcome: Outcome = redHerringHash(caseId, accusation.suspect) === loaded.file.red_herring.sha256 ? 'red-herring' : 'wrong-suspect';
    return { outcome, ...blank };
  }

  const plaintext = unseal(readFileSync(loaded.sealedPath, 'utf8'), accusation.suspect, caseId);
  if (plaintext === null) throw new Error('The verdict hash matched but the solution would not unseal. The case files are inconsistent.');
  const solution = splitSolution(plaintext);
  const groups = solution.front.cracking.map((group) => new Set(group.ev));
  const relevant = cited.filter((id) => groups.some((group) => group.has(id)));
  const groupsHit = groups.filter((group) => cited.some((id) => group.has(id))).length;
  const precision = cited.length === 0 ? 0 : relevant.length / cited.length;
  const recall = groups.length === 0 ? 0 : groupsHit / groups.length;
  const solved = groupsHit >= Math.min(MIN_GROUPS, groups.length) && precision >= MIN_PRECISION;
  return {
    outcome: solved ? 'solved' : 'weak-citations',
    unknownCitations,
    precision,
    recall,
    groupsHit,
    groupsTotal: groups.length,
    solution: solved ? solution : null,
  };
}
