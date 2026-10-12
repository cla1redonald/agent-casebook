/**
 * Case 8, The Lapsed Policy. Ardsallow and Fennach Ferry Cooperative.
 *
 * On 1 August at 09:00 the cooperative's vehicle cancellation terms change: a full refund needs
 * 24 hours' notice instead of 48. The new terms replace the old in the document collection the
 * sailings desk searches. A semantic response cache sits in front of the assistant. In the
 * incident variant the cache key has no policy version and entries never expire, so answers
 * written in July keep being served to anyone who phrases a question the July way. In the fixed
 * variant the key carries the policy version and entries expire after seven days.
 */
import { z } from 'zod';
import type { AgentConfig } from '../agent.js';
import { ResponseCache, semanticKey } from '../components/response-cache.js';
import { FaultPlan } from '../faults.js';
import { addDays, bst, makeEnv, type Recording, type RecordingMode } from '../scenario.js';
import { defineTool, type Tool } from '../tools.js';
import { ask, fnv } from './common.js';

export const CASE_ID = '08-the-lapsed-policy';
const EPOCH = '2026-07-14T23:00:00Z';
const START_DATE = '2026-07-15';
const DAYS = 48;
const CHANGE_MS = bst('2026-08-01', '09:00');
const TTL_MS = 7 * 24 * 3_600_000;

const TERMS = {
  'terms-2026-04': {
    published: '2026-04-01',
    passage:
      'Vehicle bookings: cancel at least 48 hours before departure for a full refund. Cancellations made less than 48 hours before departure are refunded at 50 per cent. ' +
      'Foot passenger tickets are refundable up to departure. Changing a sailing is free up to 24 hours before departure.',
  },
  'terms-2026-08': {
    published: '2026-08-01',
    passage:
      'Vehicle bookings: cancel at least 24 hours before departure for a full refund. Cancellations made less than 24 hours before departure are refunded at 50 per cent. ' +
      'Foot passenger tickets are refundable up to departure. Changing a sailing is free up to 24 hours before departure.',
  },
} as const;
type PolicyVersion = keyof typeof TERMS;

function policyAt(atMs: number): PolicyVersion {
  return atMs >= CHANGE_MS ? 'terms-2026-08' : 'terms-2026-04';
}

/** How customers asked in July. The same phrasings keep coming in August. */
const JULY_PHRASINGS = [
  'How much notice do I need to cancel a car booking and get a full refund?',
  'What is your cancellation policy for vehicle bookings?',
  'If I cancel my car booking, will I get a refund?',
  'Can I get my money back if I cancel the car the day before sailing?',
  'How late can I cancel a vehicle booking without losing money?',
];
/** New phrasings that first appear in August, so they miss the cache. */
const AUGUST_PHRASINGS = [
  'We need to cancel our campervan booking tomorrow morning. Is that refundable?',
  'What are the refund rules now for cancelling a car on the ferry?',
  'If I cancel 30 hours before sailing, do I get all my money back for the car?',
  'Has the cancellation notice period for vehicles changed?',
];

const SYSTEM =
  'You are the sailings desk for the Ardsallow and Fennach Ferry Cooperative. For any question about refunds, cancellations or conditions of carriage, ' +
  'use search_documents and answer from the terms it returns, quoting notice periods exactly. Keep answers short and plain.';

function tools(): Tool[] {
  return [
    defineTool({
      name: 'search_documents',
      description: "Searches the cooperative's published documents (conditions of carriage, fares, timetables) and returns the closest passage with its version.",
      input: z.object({ query: z.string() }).strict(),
      execute: async (_input, context) => {
        context.clock.advance(60 + (fnv(String(context.clock.now())) % 40));
        const version = policyAt(context.clock.now());
        const document = TERMS[version];
        return {
          content: JSON.stringify({ document: 'Conditions of carriage: vehicle bookings', version, published: document.published, passage: document.passage }),
          source: 'documents',
          attributes: { 'document.version': version },
        };
      },
    }),
  ];
}

interface Session {
  at: number;
  question: string;
  customer: number;
}

function schedule(): Session[] {
  const sessions: Session[] = [];
  let customer = 0;
  for (let day = 0; day < DAYS; day++) {
    const date = addDays(START_DATE, day);
    for (let slot = 0; slot < 2; slot++) {
      const seed = fnv(`${date}|${slot}`);
      const hour = 8 + (seed % 12);
      const minute = (seed >>> 8) % 60;
      const at = bst(date, `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
      const august = at >= CHANGE_MS;
      const pool = august && (seed >>> 16) % 5 < 2 ? AUGUST_PHRASINGS : JULY_PHRASINGS;
      sessions.push({ at, question: pool[(seed >>> 4) % pool.length] ?? JULY_PHRASINGS[0] ?? '', customer: ++customer });
    }
  }
  // The complaint: a customer cancelling about 30 hours before sailing, who asks the July way.
  sessions.push({ at: bst('2026-08-21', '16:40'), question: 'If I cancel my car booking, will I get a refund?', customer: customer + 1 });
  return sessions.sort((a, b) => a.at - b.at);
}

export async function recordCase08(variant: 'incident' | 'fixed', mode: RecordingMode = { kind: 'stub' }): Promise<Recording> {
  const faults = variant === 'incident' ? new FaultPlan([{ name: 'stale_cache' }]) : FaultPlan.none();
  const env = makeEnv(EPOCH, 8_008, faults, mode);
  const cache = new ResponseCache({ ttlMs: TTL_MS, policyVersion: () => policyAt(env.clock.now()), clock: env.clock, faults });
  const config: AgentConfig = {
    name: 'sailings-desk',
    model: env.model,
    system: SYSTEM,
    tools: tools(),
    maxTurns: 6,
    maxTokens: 1024,
    client: env.client,
    clock: env.clock,
    trace: env.trace,
    faults: env.faults,
  };
  const faulted: string[] = [];
  let documentsUpdated = false;
  for (const session of schedule()) {
    if (!documentsUpdated && session.at >= CHANGE_MS) {
      // The day the new terms were published: the old file is removed from the collection.
      env.clock.set(Math.max(CHANGE_MS, env.clock.now()));
      const traceId = env.trace.newTraceId();
      const span = env.trace.start('document collection update', 'internal', traceId, undefined, {
        'deployment.environment.name': 'production',
        attributes: { 'document.added': 'terms-2026-08', 'document.removed': 'terms-2026-04', 'document.name': 'Conditions of carriage: vehicle bookings' },
      });
      env.clock.advance(2_400);
      env.trace.end(span);
      documentsUpdated = true;
    }
    env.clock.set(Math.max(session.at, env.clock.now()));
    const traceId = env.trace.newTraceId();
    const policy = policyAt(env.clock.now());
    const root = env.trace.start('POST /v1/chat', 'server', traceId, undefined, {
      'deployment.environment.name': 'production',
      'http.request.method': 'POST',
      'http.route': '/v1/chat',
      attributes: { 'policy.version': policy, 'input.preview': session.question },
    });
    const lookup = env.trace.start('cache lookup', 'internal', traceId, root.spanId);
    env.clock.advance(6);
    const hit = cache.get(session.question);
    const keyIncludesVersion = !faults.active('stale_cache', env.clock.now());
    env.trace.end(lookup, {
      attributes: {
        'cache.hit': hit !== null,
        'cache.key': cache.key(session.question),
        'cache.key_includes_policy_version': keyIncludesVersion,
        ...(keyIncludesVersion ? { 'cache.ttl_ms': TTL_MS } : {}),
        'policy.version': policy,
        ...(hit ? { 'cache.entry_age_ms': hit.ageMs, 'cache.entry_policy_version': hit.policyVersion } : {}),
      },
    });
    let answer: string;
    if (hit) {
      answer = hit.answer;
      if (hit.policyVersion !== policy) faulted.push(traceId);
    } else {
      const result = await ask(env, config, {
        traceId,
        parentSpanId: root.spanId,
        identity: { subject: `web-visitor-${session.customer}`, role: 'customer', tenant: 'ardsallow-ferries' },
        question: session.question,
        fields: { 'deployment.environment.name': 'production', attributes: { 'policy.version': policy, 'session.channel': 'web-chat' } },
      });
      answer = result.text;
      const store = env.trace.start('cache store', 'internal', traceId, root.spanId);
      env.clock.advance(3);
      cache.set(session.question, answer);
      env.trace.end(store, { attributes: { 'cache.key': cache.key(session.question), 'cache.entry_policy_version': policy } });
    }
    env.trace.end(root, { 'http.status': 200, attributes: { 'policy.version': policy, 'input.preview': session.question, 'response.source': hit ? 'cache' : 'model', 'cache.semantic_key': semanticKey(session.question) }, ...env.trace.content(answer) });
  }
  return {
    header: env.header({
      caseId: CASE_ID,
      variant,
      epochIso: EPOCH,
      redactions: [{ field: 'customer identity', method: 'replaced with sequential web-visitor numbers' }],
    }),
    events: env.trace.events(),
    blobs: env.trace.blobs,
    faultedTraceIds: faulted,
  };
}
