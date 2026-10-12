import type { RetryRunner } from '../agent.js';
import { ApiError } from '../client.js';
import type { Clock, Rng } from '../clock.js';
import type { FaultPlan } from '../faults.js';

export function isRetryable(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 429 || error.status === 529 || error.status >= 500);
}

export interface RetryOptions {
  clock: Clock;
  rng: Rng;
  faults: FaultPlan;
  maxAttempts?: number;
  baseDelayMs?: number;
  capDelayMs?: number;
  /** Attempts made when retry_without_backoff is on. */
  stormAttempts?: number;
}

/**
 * Correct behaviour: capped exponential backoff with jitter and a small attempt budget.
 * Fault retry_without_backoff: no delay and a large attempt budget, so every failure fans out.
 * Each attempt is a separate call, so the agent loop records each one with its full input.
 */
export class RetryPolicy implements RetryRunner {
  constructor(private readonly options: RetryOptions) {}

  delayFor(attempt: number): number {
    if (this.storm()) return 0;
    const base = this.options.baseDelayMs ?? 500;
    const cap = this.options.capDelayMs ?? 8000;
    const exponential = Math.min(cap, base * 2 ** (attempt - 1));
    return Math.round(exponential * (0.5 + this.options.rng.next() / 2));
  }

  budget(): number {
    return this.storm() ? (this.options.stormAttempts ?? 12) : (this.options.maxAttempts ?? 4);
  }

  private storm(): boolean {
    return this.options.faults.active('retry_without_backoff', this.options.clock.now());
  }

  async run<T>(attempt: () => Promise<T>): Promise<T> {
    for (let made = 1; ; made++) {
      try {
        return await attempt();
      } catch (error) {
        if (!isRetryable(error) || made >= this.budget()) throw error;
        this.options.clock.advance(this.delayFor(made));
      }
    }
  }
}
