import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

export const AREAS = {
  'custom-ai-mcp': 'Custom AI and MCP',
  'production-persistent': 'Production and persistent agents',
  'desktop-rollout': 'Desktop rollout to non-technical users',
  'evals-observability': 'Evals, testing and observability',
  compliance: 'Compliance',
  'business-change': 'Business change',
  'ai-sdlc': 'AI SDLC',
} as const;
export type AreaId = keyof typeof AREAS;

const hash = z.string().regex(/^[0-9a-f]{64}$/);

export const caseFileSchema = z.object({
  id: z.string().regex(/^\d{2}-the-[a-z-]+$/),
  number: z.number().int().min(1).max(99),
  title: z.string().startsWith('The '),
  organisation: z.string(),
  status: z.enum(['recorded', 'pending']),
  recording: z.enum(['stub', 'live', 'none']),
  areas: z.array(z.enum(Object.keys(AREAS) as [AreaId, ...AreaId[]])).min(1),
  suspects: z.array(z.string()).length(6),
  red_herring: z.object({ sha256: hash }),
  verdict: z.object({ sha256: hash }),
  detector: z.string().regex(/^d\d{2}-[a-z-]+$/),
});
export type CaseFile = z.infer<typeof caseFileSchema>;

export const suspectSchema = z.object({ id: z.string().regex(/^[a-z-]+$/), name: z.string(), description: z.string() });
export type Suspect = z.infer<typeof suspectSchema>;

export interface LoadedCase {
  file: CaseFile;
  dir: string;
  tracePath: string | null;
  sealedPath: string;
}

export function loadSuspectPool(root: string): Map<string, Suspect> {
  const raw = parse(readFileSync(join(root, 'cases', 'suspects.yaml'), 'utf8')) as { suspects: unknown };
  const suspects = z.array(suspectSchema).parse(raw.suspects);
  return new Map(suspects.map((suspect) => [suspect.id, suspect]));
}

export function listCases(root: string): LoadedCase[] {
  const casesDir = join(root, 'cases');
  return readdirSync(casesDir)
    .filter((name) => /^\d{2}-the-/.test(name))
    .sort()
    .map((name) => loadCaseDir(join(casesDir, name)));
}

function loadCaseDir(dir: string): LoadedCase {
  const file = caseFileSchema.parse(parse(readFileSync(join(dir, 'case.yaml'), 'utf8')));
  const tracePath = join(dir, 'trace.jsonl');
  return { file, dir, tracePath: existsSync(tracePath) ? tracePath : null, sealedPath: join(dir, 'sealed', 'solution.md.enc') };
}

/** Accepts "3", "03", "03-the-quiet-understudy" or "the-quiet-understudy". */
export function findCase(root: string, reference: string): LoadedCase {
  const wanted = reference.trim().toLowerCase();
  const found = listCases(root).find(
    ({ file }) => file.id === wanted || String(file.number) === wanted.replace(/^0+/, '') || file.id.slice(3) === wanted,
  );
  if (!found) throw new Error(`No case matches "${reference}". Run \`whodunnit list\`.`);
  return found;
}
