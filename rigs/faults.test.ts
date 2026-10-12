import { describe, expect, it } from 'vitest';
import { ApiError, type Message } from './client.js';
import { Rng, SimClock } from './clock.js';
import { requestApproval } from './components/approval.js';
import { compact } from './components/compaction.js';
import { listFolder } from './components/connector.js';
import { runEvalCase } from './components/eval-runner.js';
import { HttpAdapter, type Handler } from './components/http-adapter.js';
import { fetchedPage, INERT_PAYLOAD, needsConfirmation } from './components/injection.js';
import { ResponseCache } from './components/response-cache.js';
import { RetryPolicy } from './components/retry.js';
import { makeRouter } from './components/router.js';
import { invoiceLine, invoiceLineV2 } from './components/schema-drift.js';
import { fetchWithFallback } from './components/upstream.js';
import { FAULT_CATALOGUE, FAULT_NAMES, FaultPlan, type FaultName } from './faults.js';
import type { ToolContext } from './tools.js';
import { TraceWriter } from './trace-writer.js';

const on = (name: FaultName) => new FaultPlan([{ name }]);
const off = FaultPlan.none();

function toolContext(faults: FaultPlan) {
  const clock = new SimClock(0);
  const trace = new TraceWriter(clock, new Rng(7), 0);
  const tool = trace.start('execute_tool t', 'internal', 'trace');
  const context: ToolContext = { identity: { subject: 's', role: 'r', tenant: 't' }, clock, trace, traceId: 'trace', spanId: tool.spanId, faults };
  return { context, trace, tool, clock };
}

describe('fault catalogue', () => {
  it('names exactly the ten faults, each with a component', () => {
    expect(FAULT_NAMES).toHaveLength(10);
    for (const name of FAULT_NAMES) expect(FAULT_CATALOGUE[name].component).toMatch(/^components\//);
  });

  it('switches faults on and off by time window', () => {
    const plan = new FaultPlan([{ name: 'stale_cache', fromMs: 100, untilMs: 200 }]);
    expect([plan.active('stale_cache', 99), plan.active('stale_cache', 100), plan.active('stale_cache', 200)]).toEqual([false, true, false]);
    expect(plan.active('router_by_length', 150)).toBe(false);
  });
});

describe('upstream_503_silent_fallback', () => {
  const request = {
    method: 'GET',
    url: 'https://api.example.scot/v1/thing',
    upstream: () => ({ status: 503, body: '{}', latencyMs: 8 }),
    snapshot: { body: '{"rows":[]}', label: 'the snapshot of 1 August', readLatencyMs: 4 },
  };

  it('returns the snapshot as if it were live when the fault is on', async () => {
    const { context } = toolContext(on('upstream_503_silent_fallback'));
    const outcome = await fetchWithFallback(context, request);
    expect(outcome).toEqual({ content: '{"rows":[]}', source: 'snapshot' });
  });

  it('marks and announces the fallback when the fault is off', async () => {
    const { context } = toolContext(off);
    const outcome = await fetchWithFallback(context, request);
    expect(outcome.errorType).toBe('upstream_unavailable');
    expect(outcome.content).toContain('Live data is unavailable');
  });

  it('records the failing HTTP call as a client span either way', async () => {
    const { context, trace, tool } = toolContext(on('upstream_503_silent_fallback'));
    await fetchWithFallback(context, request);
    trace.end(tool);
    const client = trace.events().find((e) => e['span.kind'] === 'client');
    expect(client?.['http.status']).toBe(503);
    expect(client?.parent_span_id).toBe(tool.spanId);
  });
});

describe('stale_cache', () => {
  function cache(faults: FaultPlan) {
    const clock = new SimClock(0);
    let version = 'v1';
    const store = new ResponseCache({ ttlMs: 1000, policyVersion: () => version, clock, faults });
    return { store, clock, bump: () => (version = 'v2') };
  }

  it('expires entries and keys on policy version when correct', () => {
    const { store, clock, bump } = cache(off);
    store.set('What is the refund cut-off?', 'old');
    clock.advance(2000);
    expect(store.get('What is the refund cut-off?')).toBeNull();
    store.set('What is the refund cut-off?', 'old');
    bump();
    expect(store.get('What is the refund cut-off?')).toBeNull();
  });

  it('serves old answers across time and policy versions when the fault is on', () => {
    const { store, clock, bump } = cache(on('stale_cache'));
    store.set('What is the refund cut-off?', 'old');
    clock.advance(10_000_000);
    bump();
    expect(store.get('the refund cut-off, what is it?')?.answer).toBe('old');
  });
});

describe('schema_field_rename', () => {
  it('keeps pounds before the release and fails loudly after a correct release', () => {
    expect(invoiceLineV2.safeParse(invoiceLine('A', 412.65, { released: false, faults: off, atMs: 0 })).success).toBe(true);
    expect(invoiceLineV2.safeParse(invoiceLine('A', 412.65, { released: true, faults: off, atMs: 0 })).success).toBe(false);
  });

  it('silently changes the unit under the same name and version when the fault is on', () => {
    const line = invoiceLine('A', 412.65, { released: true, faults: on('schema_field_rename'), atMs: 0 });
    expect(invoiceLineV2.parse(line).amount).toBe(41265);
  });
});

describe('scope_removed', () => {
  const request = { folder: '/jobs/2024/0412', grantedFolders: ['/home/documents'], files: ['survey.pdf'] };
  it('raises a permission error when correct', () => {
    expect(listFolder(request, { faults: off, atMs: 0 }).errorType).toBe('permission_denied');
  });
  it('lists nothing with no error when the fault is on', () => {
    const outcome = listFolder(request, { faults: on('scope_removed'), atMs: 0 });
    expect(outcome.errorType).toBeUndefined();
    expect(JSON.parse(outcome.content).files).toEqual([]);
  });
  it('lists granted folders either way', () => {
    expect(JSON.parse(listFolder({ ...request, grantedFolders: ['/jobs'] }, { faults: off, atMs: 0 }).content).files).toEqual(['survey.pdf']);
  });
});

describe('injected_tool_result', () => {
  it('appends an inert instruction only when the fault is on', () => {
    expect(fetchedPage('Menu', { faults: off, atMs: 0 })).toBe('Menu');
    expect(fetchedPage('Menu', { faults: on('injected_tool_result'), atMs: 0 })).toContain(INERT_PAYLOAD);
    expect(INERT_PAYLOAD).toContain('example.invalid');
  });
  it('requires confirmation for recipients outside the allow-list', () => {
    expect(needsConfirmation({ to: 'archive@example.invalid', subject: 'x' }, ['example.scot'])).toBe(true);
    expect(needsConfirmation({ to: 'events@example.scot', subject: 'x' }, ['example.scot'])).toBe(false);
  });
});

describe('retry_without_backoff', () => {
  async function attempts(faults: FaultPlan) {
    const clock = new SimClock(0);
    const policy = new RetryPolicy({ clock, rng: new Rng(3), faults });
    let made = 0;
    await expect(
      policy.run(async () => {
        made += 1;
        throw new ApiError(429, 'rate limited');
      }),
    ).rejects.toBeInstanceOf(ApiError);
    return { made, elapsed: clock.now() };
  }
  it('backs off with a small budget when correct', async () => {
    const { made, elapsed } = await attempts(off);
    expect(made).toBe(4);
    expect(elapsed).toBeGreaterThan(1000);
  });
  it('hammers with no delay when the fault is on', async () => {
    const { made, elapsed } = await attempts(on('retry_without_backoff'));
    expect(made).toBe(12);
    expect(elapsed).toBe(0);
  });
  it('does not retry client errors', async () => {
    const policy = new RetryPolicy({ clock: new SimClock(0), rng: new Rng(3), faults: off });
    let made = 0;
    await expect(policy.run(async () => { made += 1; throw new ApiError(400, 'bad'); })).rejects.toBeInstanceOf(ApiError);
    expect(made).toBe(1);
  });
});

describe('router_by_length', () => {
  const route = (faults: FaultPlan, text: string) =>
    makeRouter({ smallModel: 'small', largeModel: 'large', classify: (t) => (/bond|duty/.test(t) ? 'specialist' : 'routine'), clock: new SimClock(0), faults })([
      { role: 'user', content: text } as Message,
    ]);
  it('routes on difficulty when correct', () => {
    expect(route(off, 'Can cask 214 leave bond?')).toBe('large');
  });
  it('routes short hard questions to the small model when the fault is on', () => {
    expect(route(on('router_by_length'), 'Can cask 214 leave bond?')).toBe('small');
  });
});

describe('context_overflow_compaction_drop', () => {
  const messages: Message[] = [
    { role: 'user', content: 'Constraint: do not state a market value.\nFact: two-storey semi-detached house.' },
    { role: 'assistant', content: 'Understood.' },
    { role: 'user', content: 'Draft the roof section.' },
    { role: 'assistant', content: 'Roof: slate.' },
    { role: 'user', content: 'Draft the summary.' },
  ];
  it('carries constraints into the summary when correct', () => {
    const { messages: out, dropped } = compact(messages, { keepRecent: 1, faults: off, atMs: 0 });
    expect(JSON.stringify(out)).toContain('do not state a market value');
    expect(dropped).toEqual([]);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });
  it('drops constraints and keeps facts when the fault is on', () => {
    const { messages: out, dropped } = compact(messages, { keepRecent: 1, faults: on('context_overflow_compaction_drop'), atMs: 0 });
    expect(JSON.stringify(out)).not.toContain('market value');
    expect(JSON.stringify(out)).toContain('semi-detached');
    expect(dropped).toHaveLength(1);
  });
});

describe('approval_latency', () => {
  async function approve(faults: FaultPlan) {
    const clock = new SimClock(0);
    const trace = new TraceWriter(clock, new Rng(4), 0);
    const decision = await requestApproval({ diffLines: 140, questions: ['Include contact fields?', 'Keep the old export?'] }, { trace, clock, faults, traceId: 't', parentSpanId: 'p' });
    return { decision, span: trace.events()[0] };
  }
  it('takes reading time and answers questions when correct', async () => {
    const { decision, span } = await approve(off);
    expect(decision.latencyMs).toBeGreaterThan(60_000);
    expect(decision.questionsDismissed).toBe(0);
    expect(span?.attributes?.['approval.latency_ms']).toBe(decision.latencyMs);
  });
  it('approves in 400 ms with questions dismissed when the fault is on', async () => {
    const { decision } = await approve(on('approval_latency'));
    expect(decision).toMatchObject({ latencyMs: 400, questionsDismissed: 2, questionsAnswered: 0 });
  });
});

describe('in_process_eval_bypass', () => {
  async function evalTrace(faults: FaultPlan, attachmentBytes: number) {
    const clock = new SimClock(0);
    const trace = new TraceWriter(clock, new Rng(5), 0);
    const handler: Handler = async (request, context) =>
      context.identity || request.headers['x-eval-user'] ? { status: 200, body: 'answer: ok' } : { status: 401, body: 'no' };
    const adapter = new HttpAdapter({ maxBodyBytes: 1000, tokens: new Map([['tok', { subject: 'eval', role: 'eval', tenant: 't' }]]), handler, trace, clock });
    const result = await runEvalCase(
      { id: 'c1', question: 'q', attachmentBytes, expect: 'ok' },
      { suite: 's', adapter, handler, trace, clock, faults, testToken: 'tok', userAgent: 'ua' },
    );
    return { result, events: trace.events() };
  }
  it('goes through the adapter when correct, and meets the body limit', async () => {
    const small = await evalTrace(off, 0);
    expect(small.result.passed).toBe(true);
    expect(small.events.some((e) => e['span.kind'] === 'server')).toBe(true);
    const large = await evalTrace(off, 5000);
    expect(large.result).toMatchObject({ passed: false, status: 413 });
  });
  it('skips the adapter and passes regardless of size when the fault is on', async () => {
    const large = await evalTrace(on('in_process_eval_bypass'), 5000);
    expect(large.result.passed).toBe(true);
    expect(large.events.some((e) => e['span.kind'] === 'server')).toBe(false);
  });
});
