import type { TraceEvent } from '../../src/trace/schema.js';
import type { DetectorMeta, Finding } from '../types.js';

export const meta: DetectorMeta = {
  id: 'd08',
  slug: 'unversioned-cache',
  title: 'Unversioned cache',
  case: '08-the-lapsed-policy',
  status: 'implemented',
  rule: 'Cache hits older than the declared TTL, or served across a change in policy version, are reported.',
  blindSpots: [
    'Requires the cache to record entry age and the policy version it was written under (`cache.entry_age_ms`, `cache.entry_policy_version`, `policy.version`).',
    'Semantic near-misses that are cache hits under a different key are not linked.',
    'A cache with no declared TTL and no policy version is only reported if the version is recorded somewhere else on the span.',
  ],
};

const DAY_MS = 86_400_000;

/** Detects cached answers that outlived the policy or the TTL they were written under. */
export function detect(events: readonly TraceEvent[]): Finding[] {
  const findings: Finding[] = [];
  for (const event of events) {
    const attributes = event.attributes ?? {};
    if (attributes['cache.hit'] !== true) continue;
    const age = attributes['cache.entry_age_ms'];
    const ttl = attributes['cache.ttl_ms'];
    const written = attributes['cache.entry_policy_version'];
    const current = attributes['policy.version'];
    const parts: string[] = [];
    if (typeof written === 'string' && typeof current === 'string' && written !== current) {
      parts.push(`Cache hit served an answer written under policy ${written} while ${current} is in force.`);
    }
    if (typeof age === 'number' && typeof ttl === 'number' && age > ttl) parts.push(`The entry is ${(age / DAY_MS).toFixed(1)} days old, past its TTL of ${(ttl / DAY_MS).toFixed(1)} days.`);
    if (parts.length === 0) continue;
    if (typeof age === 'number' && !parts.some((part) => part.includes('days old'))) parts.push(`Entry age ${(age / DAY_MS).toFixed(1)} days.`);
    if (attributes['cache.key_includes_policy_version'] === false) parts.push('The cache key does not include the policy version.');
    findings.push({ detector: meta.id, severity: 'high', message: parts.join(' '), ev: [event.ev], trace_ids: [event.trace_id] });
  }
  return findings;
}
