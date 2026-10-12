/** Prints a sealed solution. Usage: npm run unseal -- <case> <suspect-id> */
import { readFileSync } from 'node:fs';
import { findCase } from '../src/cases/load.js';
import { unseal } from '../src/cases/seal.js';
import { repoRoot } from '../src/util/root.js';

const [reference, suspect] = process.argv.slice(2);
if (!reference || !suspect) {
  console.error('Usage: npm run unseal -- <case> <suspect-id>');
  process.exit(2);
}
const loaded = findCase(repoRoot(), reference);
const text = unseal(readFileSync(loaded.sealedPath, 'utf8'), suspect, loaded.file.id);
if (text === null) {
  console.error(`Not ${suspect}.`);
  process.exit(1);
}
process.stdout.write(text);
