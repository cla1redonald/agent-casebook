/**
 * Case 4, The Eleven Thousand Knocks. Kinbrae Bakeries.
 *
 * At 04:00 each night a batch turns the branches' orders into the bakehouse production sheet,
 * one model call per order. On Friday, the first night of a half-price pie promotion, orders are
 * about 30% up and the provider throttles the account for four minutes, twenty seconds into the batch.
 *
 * The throttle is simulated locally (decision 0001): while it lasts, every attempt is answered
 * 429 by the rig and never reaches the provider, so none of the storm is billed. Each rejected
 * attempt keeps the throttle in force for another second, as a busy account's limit does. Only
 * attempts that get through are real calls to the live model.
 *
 * Incident: the batch wraps each call in its own retry loop (12 attempts, no delay) over an SDK
 * that retries twice more with short pauses, and an order that still fails goes to the back of
 * the queue at once, so it never drops. Fixed: one retry layer that honours retry-after, with
 * backoff and jitter, and a circuit breaker that pauses the batch after three failed orders.
 */
import type { RetryRunner } from '../agent.js';
import { runAgent, type AgentConfig } from '../agent.js';
import { ApiError, type MessagesClient, type MessagesRequest, type MessagesResponse } from '../client.js';
import type { Clock, Rng } from '../clock.js';
import { RetryPolicy } from '../components/retry.js';
import { FaultPlan } from '../faults.js';
import { bst, makeEnv, type Recording, type RecordingMode, type ScenarioEnv } from '../scenario.js';
import { fnv } from './common.js';

export const CASE_ID = '04-the-eleven-thousand-knocks';
const EPOCH = '2026-10-07T23:00:00Z';
const NIGHTS = [
  { date: '2026-10-08', label: 'Thursday', orders: 30, promotion: false },
  { date: '2026-10-09', label: 'Friday', orders: 40, promotion: true },
] as const;
// Twenty seconds into Friday's batch, about the tenth order.
const THROTTLE_FROM = bst('2026-10-09', '04:00') + 20_000;
const THROTTLE_BASE_MS = 4 * 60_000;
/** Each rejected attempt keeps the throttle in force this much longer, up to the cap. */
const THROTTLE_PENALTY_MS = 1_000;
const THROTTLE_CAP = bst('2026-10-09', '04:30');
const RETRY_AFTER_MS = 20_000;
const API_URL = 'https://api.anthropic.com/v1/messages';

const BRANCHES = ['High Street', 'Station', 'Pier', 'Kirkgate', 'Market Square', 'Harbour', 'Abbey Road', 'Mill Wynd', 'Cross', 'Shore Road', 'Westport'];
const PRODUCTS = ['morning rolls', 'Scotch pies', 'bridies', 'empire biscuits', 'tattie scones', 'sausage rolls', 'plain loaves', 'fern cakes'];

function usual(branch: string, product: string): number {
  return 2 + (fnv(`${branch}|${product}`) % 9);
}

/** The batch context: catalogue, usual quantities and the night's promotion. Stable, so it caches. */
function batchContext(promotion: boolean): string {
  const rows = BRANCHES.flatMap((branch) => PRODUCTS.map((product) => `${branch} | ${product} | ${usual(branch, product)} trays`));
  return [
    'You write lines for the Kinbrae Bakeries bakehouse production sheet. For each branch order you are given, reply with exactly one line:',
    'BRANCH | PRODUCT | TRAYS TO BAKE | NOTE. Trays to bake equal the trays ordered. NOTE is "check" when the order is more than 50% above the usual quantity below, otherwise "ok".',
    promotion ? 'Promotion tonight: half-price Scotch pies at every branch. Pie orders above usual are expected; still mark them "check" by the rule.' : 'No promotion tonight.',
    'Usual quantities (branch | product | trays):',
    ...rows,
  ].join('\n');
}

interface Order {
  id: string;
  branch: string;
  product: string;
  trays: number;
}

function ordersFor(night: (typeof NIGHTS)[number]): Order[] {
  return Array.from({ length: night.orders }, (_, index) => {
    const branch = BRANCHES[index % BRANCHES.length] ?? 'High Street';
    const product = night.promotion && index % 3 === 0 ? 'Scotch pies' : (PRODUCTS[fnv(`${night.date}|${index}`) % PRODUCTS.length] ?? 'morning rolls');
    const base = usual(branch, product);
    const trays = night.promotion && product === 'Scotch pies' ? base * 2 : base + (fnv(`${night.date}|t${index}`) % 3) - 1;
    return { id: `KB-${night.date.slice(5).replace('-', '')}-${String(index + 1).padStart(3, '0')}`, branch, product, trays: Math.max(1, trays) };
  });
}

/** The provider as the batch meets it: throttled for a while on Friday, otherwise the live model. */
class Throttle {
  private until = THROTTLE_FROM + THROTTLE_BASE_MS;
  rejected = 0;

  constructor(private readonly clock: Clock) {}

  active(): boolean {
    const now = this.clock.now();
    return now >= THROTTLE_FROM && now < this.until;
  }

  reject(): void {
    this.rejected += 1;
    this.until = Math.min(THROTTLE_CAP, this.until + THROTTLE_PENALTY_MS);
  }
}

/**
 * Sits where the SDK's HTTP layer would be. Every attempt is an HTTP client span beneath the chat
 * span. Attempts made while the throttle is in force are answered 429 locally; the rest go to the
 * live client. `sdkAttempts` is 3 in the incident (the SDK's two retries) and 1 in the fix.
 */
class SdkLayer implements MessagesClient {
  readonly provider: string;

  constructor(
    private readonly inner: MessagesClient,
    private readonly env: ScenarioEnv,
    private readonly throttle: Throttle,
    private readonly sdkAttempts: number,
  ) {
    this.provider = inner.provider;
  }

  async create(request: MessagesRequest): Promise<MessagesResponse> {
    const { trace, clock } = this.env;
    const chat = trace.latestOpen('chat ');
    const bodyBytes = Buffer.byteLength(JSON.stringify(request));
    for (let attempt = 1; ; attempt++) {
      const span = trace.start(`POST /v1/messages`, 'client', chat?.traceId ?? 'unknown', chat?.spanId, {
        'http.request.method': 'POST',
        'url.full': API_URL,
        'http.request.body.size': bodyBytes,
        attributes: { 'retry.layer': 'sdk', 'retry.attempt': attempt },
      });
      if (this.throttle.active()) {
        clock.advance(12 + (fnv(`${clock.now()}|${attempt}`) % 9));
        this.throttle.reject();
        trace.end(span, {
          'http.status': 429,
          'error.type': '429',
          attributes: { 'retry.layer': 'sdk', 'retry.attempt': attempt, 'http.response.header.retry-after': String(RETRY_AFTER_MS / 1000), 'rate_limit.simulated': true },
        });
        if (attempt >= this.sdkAttempts) throw new ApiError(429, 'rate_limit_error (simulated locally; not sent to the provider)');
        // The SDK's own pause between its retries.
        clock.advance(attempt === 1 ? 500 : 1_000);
        continue;
      }
      try {
        const response = await this.inner.create(request);
        trace.end(span, { 'http.status': 200, attributes: { 'retry.layer': 'sdk', 'retry.attempt': attempt } });
        return response;
      } catch (error) {
        const status = error instanceof ApiError ? error.status : undefined;
        trace.end(span, { ...(status ? { 'http.status': status } : {}), 'error.type': status ? String(status) : 'exception' });
        throw error;
      }
    }
  }
}

/** The fix: one retry layer that waits the retry-after it is given, with jitter, and a small budget. */
class HonouringRetry implements RetryRunner {
  constructor(
    private readonly clock: Clock,
    private readonly rng: Rng,
  ) {}

  async run<T>(attempt: () => Promise<T>): Promise<T> {
    for (let made = 1; ; made++) {
      try {
        return await attempt();
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 429 || made >= 5) throw error;
        this.clock.advance(Math.round(RETRY_AFTER_MS * (1 + this.rng.next() / 2)));
      }
    }
  }
}

export async function recordCase04(variant: 'incident' | 'fixed', mode: RecordingMode = { kind: 'stub' }): Promise<Recording> {
  const incident = variant === 'incident';
  const faults = incident ? new FaultPlan([{ name: 'retry_without_backoff' }]) : FaultPlan.none();
  const env = makeEnv(EPOCH, 4_004, faults, mode);
  const throttle = new Throttle(env.clock);
  const client = new SdkLayer(env.client, env, throttle, incident ? 3 : 1);
  const retry: RetryRunner = incident ? new RetryPolicy({ clock: env.clock, rng: env.rng, faults, stormAttempts: 12 }) : new HonouringRetry(env.clock, env.rng);
  const faulted = new Set<string>();

  for (const night of NIGHTS) {
    env.clock.set(Math.max(bst(night.date, '04:00'), env.clock.now()));
    const batchTrace = env.trace.newTraceId();
    const batch = env.trace.start(`batch production-sheet ${night.date}`, 'internal', batchTrace, undefined, {
      'deployment.environment.name': 'production',
      attributes: { 'batch.night': night.label, 'batch.orders': night.orders, 'batch.promotion': night.promotion },
    });
    const config: AgentConfig = {
      name: 'production-sheet',
      model: env.model,
      system: batchContext(night.promotion),
      tools: [],
      maxTurns: 1,
      maxTokens: 200,
      client,
      clock: env.clock,
      trace: env.trace,
      faults: env.faults,
      retry,
    };
    const queue = ordersFor(night).map((order) => ({ order, traceId: env.trace.newTraceId(), passes: 0 }));
    let consecutiveFailures = 0;
    let logicalRequests = 0;
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      item.passes += 1;
      logicalRequests += 1;
      const before = throttle.rejected;
      const result = await runAgent(config, {
        traceId: item.traceId,
        identity: { subject: 'batch-0400', role: 'batch', tenant: 'kinbrae-bakeries' },
        messages: [{ role: 'user', content: `Order ${item.order.id}: ${item.order.branch} branch, ${item.order.product}, ${item.order.trays} trays.` }],
        fields: { 'deployment.environment.name': 'production', attributes: { 'order.id': item.order.id, 'order.round': item.passes } },
      });
      if (incident && throttle.rejected - before > 3) faulted.add(item.traceId);
      if (result.outcome === 'error') {
        consecutiveFailures += 1;
        if (incident) {
          // "So it never drops an order": straight to the back of the queue.
          queue.push(item);
        } else {
          queue.push(item);
          if (consecutiveFailures >= 3) {
            const pause = env.trace.start('circuit open', 'internal', batchTrace, batch.spanId, { attributes: { 'circuit.reason': '3 orders failed in a row', 'circuit.pause_ms': 60_000 } });
            env.clock.advance(60_000);
            env.trace.end(pause);
            consecutiveFailures = 0;
          }
        }
      } else {
        consecutiveFailures = 0;
      }
    }
    env.trace.end(batch, { attributes: { 'batch.night': night.label, 'batch.orders': night.orders, 'batch.promotion': night.promotion, 'batch.logical_requests': logicalRequests } });
  }
  return {
    header: env.header({
      caseId: CASE_ID,
      variant,
      epochIso: EPOCH,
      redactions: [{ field: 'request bodies', method: 'size recorded, content not stored' }],
      notes: [
        "The provider's throttle is simulated by the rig: attempts made while it is in force are answered 429 locally and never reach the provider, so the storm itself was not billed.",
        'Only attempts recorded with http.status 200 are live model calls.',
      ],
    }),
    events: env.trace.events(),
    blobs: env.trace.blobs,
    faultedTraceIds: [...faulted],
  };
}
