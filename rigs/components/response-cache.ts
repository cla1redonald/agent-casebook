import type { Clock } from '../clock.js';
import type { FaultPlan } from '../faults.js';

export interface CachedAnswer {
  answer: string;
  ageMs: number;
  policyVersion: string;
}

/** Crude semantic key: lower case, punctuation stripped, words sorted, short words dropped. */
export function semanticKey(question: string): string {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 3)
    .sort()
    .join(' ');
}

/**
 * Semantic response cache.
 * Correct behaviour: the policy version is part of the key and entries expire after ttlMs.
 * Fault stale_cache: no expiry and no policy version in the key, so answers outlive the policy.
 */
export class ResponseCache {
  private readonly entries = new Map<string, { answer: string; storedAt: number; policyVersion: string }>();

  constructor(
    private readonly options: { ttlMs: number; policyVersion: () => string; clock: Clock; faults: FaultPlan },
  ) {}

  private faulty(): boolean {
    return this.options.faults.active('stale_cache', this.options.clock.now());
  }

  key(question: string): string {
    return this.faulty() ? semanticKey(question) : `${this.options.policyVersion()}::${semanticKey(question)}`;
  }

  get(question: string): CachedAnswer | null {
    const key = this.key(question);
    const entry = this.entries.get(key);
    if (!entry) return null;
    const ageMs = this.options.clock.now() - entry.storedAt;
    if (!this.faulty() && ageMs > this.options.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    return { answer: entry.answer, ageMs, policyVersion: entry.policyVersion };
  }

  set(question: string, answer: string): void {
    this.entries.set(this.key(question), { answer, storedAt: this.options.clock.now(), policyVersion: this.options.policyVersion() });
  }
}
