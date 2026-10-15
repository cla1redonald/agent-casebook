import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Finds the repo root by walking up to the package.json named agent-casebook. */
export function repoRoot(): string {
  const override = process.env.CASEBOOK_ROOT;
  if (override) return override;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string };
      if (pkg.name === 'agent-casebook') return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Could not find the agent-casebook repo root. Set CASEBOOK_ROOT.');
    dir = parent;
  }
}
