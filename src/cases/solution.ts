import { parse } from 'yaml';
import { z } from 'zod';

/** Front matter at the top of every sealed solution. */
export const solutionFrontMatterSchema = z.object({
  case: z.string(),
  suspect: z.string(),
  red_herring: z.string(),
  cracking: z.array(z.object({ label: z.string(), ev: z.array(z.string()), planned: z.string().optional() })).min(1),
  cheapest_test: z.string(),
});
export type SolutionFrontMatter = z.infer<typeof solutionFrontMatterSchema>;

export function splitSolution(text: string): { front: SolutionFrontMatter; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error('Solution has no front matter.');
  return { front: solutionFrontMatterSchema.parse(parse(match[1] ?? '')), body: (match[2] ?? '').trim() };
}
