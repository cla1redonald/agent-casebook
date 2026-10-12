import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runAgent, type AgentConfig } from './agent.js';
import { ApiError, type MessagesClient, type MessagesRequest, type MessagesResponse } from './client.js';
import { Rng, SimClock } from './clock.js';
import { RetryPolicy } from './components/retry.js';
import { FaultPlan } from './faults.js';
import { callTool, say, StubClient, type StubScript } from './stub.js';
import { defineTool, type Identity } from './tools.js';
import { TraceWriter } from './trace-writer.js';

const IDENTITY: Identity = { subject: 'harness-user', role: 'tester', tenant: 'example' };

function setup(script: StubScript, overrides: Partial<AgentConfig> = {}) {
  const clock = new SimClock(0);
  const trace = new TraceWriter(clock, new Rng(1), 0);
  const stub = new StubClient(clock);
  stub.load(script);
  const seen: Identity[] = [];
  const echo = defineTool({
    name: 'echo',
    description: 'Echoes a word.',
    input: z.object({ word: z.string().min(1) }).strict(),
    execute: async (input, context) => {
      seen.push(context.identity);
      context.clock.advance(5);
      return { content: `echo:${input.word}`, source: 'local' };
    },
  });
  const config: AgentConfig = {
    name: 'test-agent',
    model: 'claude-sonnet-5-5',
    system: 'Test.',
    tools: [echo],
    maxTurns: 5,
    maxTokens: 256,
    client: stub,
    clock,
    trace,
    faults: FaultPlan.none(),
    ...overrides,
  };
  const run = () => runAgent(config, { traceId: 't1', identity: IDENTITY, messages: [{ role: 'user', content: 'hello' }] });
  return { run, trace, seen, clock };
}

describe('runAgent', () => {
  it('runs a tool and finishes on end_turn, recording every call with usage and duration', async () => {
    const { run, trace, seen } = setup({ 0: (c) => callTool(c, 'echo', { word: 'hi' }), 1: () => say('done') });
    const result = await run();
    expect(result.outcome).toBe('end_turn');
    expect(result.text).toBe('done');
    expect(result.turns).toBe(2);
    const events = trace.events();
    expect(events.map((e) => e['gen_ai.operation.name'])).toEqual(['invoke_agent', 'chat', 'execute_tool', 'chat']);
    const chat = events[1];
    expect(chat?.['gen_ai.usage.input_tokens']).toBeGreaterThan(0);
    expect(chat?.['gen_ai.usage.output_tokens']).toBeGreaterThan(0);
    expect(chat?.duration_ms).toBeGreaterThan(0);
    expect(chat?.cost_usd).toBeGreaterThan(0);
    expect(events[2]?.source).toBe('local');
    expect(seen).toEqual([IDENTITY]);
  });

  it('injects identity from the harness even if the model tries to supply one', async () => {
    const { run, trace, seen } = setup({ 0: (c) => callTool(c, 'echo', { word: 'hi', subject: 'admin' }), 1: () => say('ok') });
    await run();
    // The strict schema rejects the extra field, so the tool never runs with model-supplied identity.
    expect(seen).toEqual([]);
    const tool = trace.events().find((e) => e['gen_ai.operation.name'] === 'execute_tool');
    expect(tool?.['error.type']).toBe('invalid_input');
  });

  it('validates tool input before execution and returns the error to the model', async () => {
    const { run, trace, seen } = setup({
      0: (c) => callTool(c, 'echo', { word: '' }),
      1: (c) => callTool(c, 'echo', { word: 'fixed' }),
      2: () => say('ok'),
    });
    const result = await run();
    expect(result.outcome).toBe('end_turn');
    expect(seen).toHaveLength(1);
    const tools = trace.events().filter((e) => e['gen_ai.operation.name'] === 'execute_tool');
    expect(tools.map((e) => e['error.type'])).toEqual(['invalid_input', undefined]);
  });

  it('reports an unknown tool as an error result rather than throwing', async () => {
    const { run, trace } = setup({ 0: (c) => callTool(c, 'missing', {}), 1: () => say('ok') });
    await run();
    expect(trace.events().find((e) => e['gen_ai.tool.name'] === 'missing')?.['error.type']).toBe('unknown_tool');
  });

  it('stops at the turn limit counted in code', async () => {
    const loop: StubScript = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((turn) => [turn, (c) => callTool(c, 'echo', { word: `w${turn}` })]));
    const { run } = setup(loop, { maxTurns: 3 });
    const result = await run();
    expect(result.outcome).toBe('turn_limit');
    expect(result.turns).toBe(3);
  });

  it('resends on pause_turn', async () => {
    const { run } = setup({ 0: () => say('working', 'pause_turn'), 1: () => say('finished') });
    const result = await run();
    expect(result.outcome).toBe('end_turn');
    expect(result.turns).toBe(2);
  });

  it('continues once after max_tokens, then gives up', async () => {
    const once = setup({ 0: () => say('part one', 'max_tokens'), 1: () => say('part two') });
    expect((await once.run()).outcome).toBe('end_turn');
    const twice = setup({ 0: () => say('a', 'max_tokens'), 1: () => say('b', 'max_tokens'), 2: () => say('c') });
    expect((await twice.run()).outcome).toBe('max_tokens');
  });

  it.each([
    ['stop_sequence', 'stop_sequence'],
    ['refusal', 'refusal'],
    ['model_context_window_exceeded', 'context_exceeded'],
  ] as const)('routes %s to outcome %s', async (stopReason, outcome) => {
    const { run, trace } = setup({ 0: () => say('x', stopReason) });
    const result = await run();
    expect(result.outcome).toBe(outcome);
    const root = trace.events()[0];
    expect(root?.attributes?.['agent.outcome']).toBe(outcome);
  });

  it('treats a null stop reason as an error', async () => {
    const nullClient: MessagesClient = {
      provider: 'fake',
      create: async (request: MessagesRequest): Promise<MessagesResponse> => ({
        id: 'm',
        model: request.model,
        content: [{ type: 'text', text: 'x' }],
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    };
    const { run } = setup({}, { client: nullClient });
    expect((await run()).outcome).toBe('error');
  });

  it('records each failed attempt when a retry policy is in play', async () => {
    const clock = new SimClock(0);
    let calls = 0;
    const flaky: MessagesClient = {
      provider: 'fake',
      create: async (request) => {
        calls += 1;
        if (calls === 1) throw new ApiError(529, 'overloaded');
        return { id: 'm', model: request.model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 1 } };
      },
    };
    const { run, trace } = setup({}, { client: flaky, clock, retry: new RetryPolicy({ clock, rng: new Rng(2), faults: FaultPlan.none() }) });
    const result = await run();
    expect(result.outcome).toBe('end_turn');
    const chats = trace.events().filter((e) => e['gen_ai.operation.name'] === 'chat');
    expect(chats.map((e) => e['error.type'])).toEqual(['529', undefined]);
    expect(chats[0]?.['http.status']).toBe(529);
  });
});
