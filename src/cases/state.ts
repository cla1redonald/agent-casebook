import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

const stateSchema = z.object({
  cases: z.record(z.string(), z.object({ attempts: z.number().int().nonnegative(), solved: z.boolean(), solvedOnAttempt: z.number().int().optional() })),
});
export type PlayState = z.infer<typeof stateSchema>;

/** Local, gitignored state: attempt counts and solved cases. */
export function statePath(root: string): string {
  return process.env.CASEBOOK_STATE ?? join(root, '.casebook', 'state.json');
}

export function readState(path: string): PlayState {
  if (!existsSync(path)) return { cases: {} };
  const parsed = stateSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  return parsed.success ? parsed.data : { cases: {} };
}

export function writeState(path: string, state: PlayState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}
