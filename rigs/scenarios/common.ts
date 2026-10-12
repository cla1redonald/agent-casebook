/** Small helpers shared by the Phase 3b scenarios. */
import { runAgent, type AgentConfig, type RunResult } from '../agent.js';
import type { Message } from '../client.js';
import type { ScenarioEnv } from '../scenario.js';
import type { SpanFields } from '../trace-writer.js';
import type { Identity } from '../tools.js';

/** Stable small hash (FNV-1a) so simulated data does not depend on call order. */
export function fnv(text: string): number {
  let value = 2166136261;
  for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619) >>> 0;
  return value;
}

/** Pounds with two decimals, deterministic from a seed string, between min and max. */
export function pounds(seed: string, min: number, max: number): number {
  const span = Math.round((max - min) * 100);
  return Math.round(min * 100 + (fnv(seed) % span)) / 100;
}

export interface SessionInput {
  traceId?: string;
  parentSpanId?: string;
  identity: Identity;
  question: string;
  /** Earlier turns, for multi-turn sessions. */
  history?: Message[];
  fields?: SpanFields;
}

/** Runs one user turn with the date stamp live recordings need, and returns the result and trace id. */
export async function ask(env: ScenarioEnv, config: AgentConfig, input: SessionInput): Promise<RunResult & { traceId: string }> {
  const traceId = input.traceId ?? env.trace.newTraceId();
  const result = await runAgent(config, {
    traceId,
    ...(input.parentSpanId ? { parentSpanId: input.parentSpanId } : {}),
    identity: input.identity,
    messages: [...(input.history ?? []), { role: 'user', content: env.userTurn(input.question) }],
    ...(input.fields ? { fields: input.fields } : {}),
  });
  return { ...result, traceId };
}

/** Working days (Monday to Friday) from start, inclusive, for n calendar days. */
export function workingDays(startIso: string, days: number): string[] {
  const out: string[] = [];
  for (let day = 0; day < days; day++) {
    const date = new Date(`${startIso}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + day);
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6) out.push(date.toISOString().slice(0, 10));
  }
  return out;
}
