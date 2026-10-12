/**
 * Seals authored solutions. Reads authoring/solutions/<case>.md (gitignored), replaces the
 * cracking groups of recorded cases with the ids computed by the recorder
 * (authoring/cracking/<case>.json), encrypts to cases/<case>/sealed/solution.md.enc and writes
 * the verdict and red herring hashes into case.yaml.
 *
 *   npm run seal              seal every case that has an authored solution
 *   npm run seal -- 03        seal one case
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { redHerringHash, seal, verdictHash } from '../src/cases/seal.js';
import { splitSolution } from '../src/cases/solution.js';
import { repoRoot } from '../src/util/root.js';

const root = repoRoot();
const only = process.argv[2];
const solutionsDir = join(root, 'authoring', 'solutions');
if (!existsSync(solutionsDir)) {
  console.error('No authoring/solutions directory. Recover a solution with `npm run unseal -- <case> <suspect>`.');
  process.exit(1);
}

let sealed = 0;
for (const name of readdirSync(solutionsDir).filter((file) => file.endsWith('.md')).sort()) {
  const caseId = name.replace(/\.md$/, '');
  if (only && !caseId.startsWith(only.padStart(2, '0'))) continue;
  const { front, body } = splitSolution(readFileSync(join(solutionsDir, name), 'utf8'));
  if (front.case !== caseId) throw new Error(`${name}: front matter case is ${front.case}`);
  const crackingPath = join(root, 'authoring', 'cracking', `${caseId}.json`);
  const cracking = existsSync(crackingPath) ? (JSON.parse(readFileSync(crackingPath, 'utf8')) as typeof front.cracking) : front.cracking;
  const plaintext = `---\n${stringify({ ...front, cracking })}---\n\n${body}\n`;

  const caseDir = join(root, 'cases', caseId);
  const yamlPath = join(caseDir, 'case.yaml');
  const yaml = readFileSync(yamlPath, 'utf8');
  const suspects = /suspects:\n((?:\s+- .+\n)+)/.exec(yaml)?.[1]?.match(/- (.+)/g)?.map((line) => line.slice(2).trim()) ?? [];
  for (const id of [front.suspect, front.red_herring]) if (!suspects.includes(id)) throw new Error(`${caseId}: ${id} is not in the line-up`);

  mkdirSync(join(caseDir, 'sealed'), { recursive: true });
  writeFileSync(join(caseDir, 'sealed', 'solution.md.enc'), seal(plaintext, front.suspect, caseId));
  const updated = yaml
    .replace(/(red_herring:\n\s+sha256: )\S+/, `$1${redHerringHash(caseId, front.red_herring)}`)
    .replace(/(verdict:\n\s+sha256: )\S+/, `$1${verdictHash(caseId, front.suspect)}`);
  writeFileSync(yamlPath, updated);
  sealed += 1;
  console.log(`sealed ${caseId}`);
}
console.log(`${sealed} solution(s) sealed.`);
