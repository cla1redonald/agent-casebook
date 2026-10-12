import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readTrace } from '../src/trace/read.js';
import { repoRoot } from '../src/util/root.js';
import { AnthropicMessagesClient, fromMessage, strictSchema, toParams, type SdkLike } from './anthropic.js';
import { ApiError } from './client.js';
import { Rng, SimClock } from './clock.js';
import { costUsd } from './pricing.js';
import { formatPlan, planRecording, renderAll, resolveTargets, TARGETS } from './record.js';
import { say, StubClient } from './stub.js';
import { TraceWriter } from './trace-writer.js';

describe('StubClient', () => {
  it('answers by turn, deterministically, and names itself as a stub', async () => {
    const run = async () => {
      const clock = new SimClock(0);
      const stub = new StubClient(clock);
      stub.load({ 0: () => say('first'), 1: () => say('second') });
      const a = await stub.create({ model: 'claude-sonnet-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
      const b = await stub.create({
        model: 'claude-sonnet-5-5',
        max_tokens: 10,
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'first' },
          { role: 'user', content: 'again' },
        ],
      });
      return { a, b, elapsed: clock.now() };
    };
    const first = await run();
    expect(first.a.content).toEqual([{ type: 'text', text: 'first' }]);
    expect(first.b.content).toEqual([{ type: 'text', text: 'second' }]);
    expect(first.a.model).toBe('stub/claude-sonnet-5-5');
    expect(await run()).toEqual(first);
  });

  it('ends the conversation when the script has no entry for the turn', async () => {
    const stub = new StubClient(new SimClock(0));
    const reply = await stub.create({ model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] });
    expect(reply.stop_reason).toBe('end_turn');
  });
});

describe('TraceWriter', () => {
  it('writes spans in start order with sequential ev ids and moves long content to the locker', () => {
    const clock = new SimClock(1000);
    const writer = new TraceWriter(clock, new Rng(9), 1000);
    const parent = writer.start('parent', 'internal', 't');
    const child = writer.start('child', 'client', 't', parent.spanId);
    clock.advance(50);
    writer.end(child, writer.content('x'.repeat(500)));
    writer.end(parent);
    const [first, second] = writer.events();
    expect(first?.ev).toBe('ev-001');
    expect(first?.name).toBe('parent');
    expect(second?.parent_span_id).toBe(first?.span_id);
    expect(second?.duration_ms).toBe(50);
    expect(second?.locker).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(writer.blobs.size).toBe(1);
  });

  it('refuses to export while a span is open', () => {
    const writer = new TraceWriter(new SimClock(0), new Rng(1), 0);
    writer.start('open', 'internal', 't');
    expect(() => writer.events()).toThrow(/still open/);
  });
});

describe('pricing', () => {
  it('prices Sonnet 5.5 at $2 and $10 per million tokens', () => {
    expect(costUsd('claude-sonnet-5-5', { input_tokens: 1_000_000, output_tokens: 100_000 })).toBe(3);
  });

  it('prices Haiku 5.5 at list price, with cache reads and writes', () => {
    expect(costUsd('claude-haiku-5-5', { input_tokens: 100_000, output_tokens: 100_000 })).toBe(0.06);
    expect(costUsd('claude-haiku-5-5', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 100_000 })).toBe(0.001);
    expect(costUsd('claude-haiku-5-5', { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 100_000 })).toBe(0.0125);
    expect(costUsd('claude-sonnet-5-5', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 })).toBe(0.2);
  });

  it('switches Haiku 5.5 to the long-context card above 100,000 prompt tokens', () => {
    expect(costUsd('claude-haiku-5-5', { input_tokens: 100_000, output_tokens: 0 })).toBe(0.01);
    // 120,000 prompt tokens: the long card, $0.50 input and $0.05 cache read.
    expect(costUsd('claude-haiku-5-5', { input_tokens: 60_000, output_tokens: 0, cache_read_input_tokens: 60_000 })).toBe(0.033);
    expect(costUsd('claude-haiku-5-5', { input_tokens: 1_000_000, output_tokens: 1_000_000 })).toBe(3);
  });

  it('refuses a model it has no price for', () => {
    expect(() => costUsd('claude-unknown', { input_tokens: 1, output_tokens: 1 })).toThrow(/No price/);
  });
});

describe('AnthropicMessagesClient', () => {
  const sdkMessage = (params: Anthropic.MessageCreateParamsNonStreaming, extra: Record<string, unknown> = {}): Anthropic.Message =>
    ({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: params.model,
      content: [
        { type: 'text', text: 'Checking.', citations: null },
        { type: 'tool_use', id: 'toolu_1', name: 'echo', input: { word: 'hi' }, caller: { type: 'direct' } },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 600, cache_creation_input_tokens: 0 },
      ...extra,
    }) as unknown as Anthropic.Message;

  const request = {
    model: 'claude-haiku-5-5',
    max_tokens: 100,
    system: 'Be brief.',
    messages: [
      { role: 'user' as const, content: 'hi' },
      { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 'toolu_0', name: 'echo', input: {} }] },
      { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 'toolu_0', content: 'ok' }] },
    ],
    tools: [
      {
        name: 'echo',
        description: 'Echo.',
        input_schema: { type: 'object', properties: { word: { type: 'string', minLength: 1 }, times: { type: 'integer', minimum: 1, maximum: 9 } }, required: ['word', 'times'], additionalProperties: false },
      },
    ],
  };

  it('refuses to start without ANTHROPIC_API_KEY', () => {
    expect(() => AnthropicMessagesClient.fromEnv({})).toThrow(/not set/);
  });

  it('caches the stable prefix: a breakpoint on the system block and automatic caching for the tail', () => {
    const params = toParams(request);
    expect(params.system).toEqual([{ type: 'text', text: 'Be brief.', cache_control: { type: 'ephemeral' } }]);
    expect(params.cache_control).toEqual({ type: 'ephemeral' });
    // Nothing that varies per request precedes the breakpoint: tools and system are rendered first.
    expect(JSON.stringify(toParams(request).tools)).toBe(JSON.stringify(params.tools));
  });

  it('marks every tool strict and drops the constraints strict mode does not accept', () => {
    const tool = toParams(request).tools?.[0] as Anthropic.Tool;
    expect(tool.strict).toBe(true);
    expect(tool.input_schema).toEqual({ type: 'object', properties: { word: { type: 'string' }, times: { type: 'integer' } }, required: ['word', 'times'], additionalProperties: false });
  });

  it('closes every object and lists every property as required', () => {
    expect(strictSchema({ type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'number', multipleOf: 2 } } } } })).toEqual({
      type: 'object',
      properties: { a: { type: 'object', properties: { b: { type: 'number' } }, additionalProperties: false, required: ['b'] } },
      additionalProperties: false,
      required: ['a'],
    });
  });

  it('turns thinking off at low effort, as the skill documents for Haiku 5.5', () => {
    const params = toParams(request);
    expect(params.thinking).toEqual({ type: 'disabled' });
    expect(params.output_config).toEqual({ effort: 'low' });
  });

  it('turns Sonnet 5.5 thinking off with between_tools, since it rejects disabled', () => {
    expect(toParams({ ...request, model: 'claude-sonnet-5-5' }).thinking).toEqual({ type: 'between_tools' });
  });

  it('can send a plain request with caching and strict mode off', () => {
    const params = toParams(request, { cache: false, strictTools: false, effort: 'medium', thinking: 'adaptive' });
    expect(params.system).toBe('Be brief.');
    expect(params.cache_control).toBeUndefined();
    expect((params.tools?.[0] as Anthropic.Tool).strict).toBeUndefined();
  });

  it('maps responses, including cache usage', async () => {
    let sent: Anthropic.MessageCreateParamsNonStreaming | undefined;
    const fake: SdkLike = { messages: { create: async (params) => ((sent = params), sdkMessage(params)) } };
    const response = await new AnthropicMessagesClient(fake).create(request);
    expect(sent?.messages).toHaveLength(3);
    expect(response.stop_reason).toBe('tool_use');
    expect(response.content).toEqual([
      { type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 'toolu_1', name: 'echo', input: { word: 'hi' } },
    ]);
    expect(response.usage).toEqual({ input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 600, cache_creation_input_tokens: 0 });
    expect(response.stop_details).toBeUndefined();
  });

  it('keeps the refusal category when stop_reason is refusal', async () => {
    const fake: SdkLike = {
      messages: { create: async (params) => sdkMessage(params, { content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'x' } }) },
    };
    const response = await new AnthropicMessagesClient(fake).create(request);
    expect(response.stop_reason).toBe('refusal');
    expect(response.stop_details).toEqual({ category: 'cyber', explanation: 'x' });
  });

  it('turns SDK API errors into ApiError with the status', async () => {
    const fake: SdkLike = {
      messages: {
        create: async () => {
          throw new Anthropic.APIError(429, { type: 'error' }, 'rate limited', new Headers());
        },
      },
    };
    await expect(new AnthropicMessagesClient(fake).create({ model: 'm', max_tokens: 1, messages: [] })).rejects.toMatchObject({ status: 429 });
    expect(new ApiError(500, 'x').status).toBe(500);
  });

  it('exports pure mapping helpers', () => {
    expect(toParams({ model: 'm', max_tokens: 1, messages: [] }).messages).toEqual([]);
    expect(typeof fromMessage).toBe('function');
  });
});

describe('recordings', () => {
  const root = repoRoot();

  it('are reproducible: a fresh recording matches the committed files byte for byte', async () => {
    const { files } = await renderAll(root);
    const differing = files.filter((file) => readFileSync(file.path, 'utf8') !== file.content).map((file) => file.path.slice(root.length + 1));
    expect(differing).toEqual([]);
  });

  it('label live recordings as live, in the header and on every model response', () => {
    for (const path of ['cases/03-the-quiet-understudy/trace.jsonl', 'cases/06-the-marked-paper/sealed/trace.fixed.jsonl', 'corpus/control/c01-ferry-live.jsonl']) {
      const trace = readTrace(join(root, path));
      expect(trace.header?.recording).toBe('live');
      expect(trace.header?.model).toBe('claude-haiku-5-5');
      expect(trace.header?.clock).toBe('mixed');
      expect(trace.header?.note).toMatch(/^LIVE RECORDING\. Every model response in this file came from claude-haiku-5-5/);
      const chats = trace.events.filter((event) => event['gen_ai.operation.name'] === 'chat' && event['gen_ai.response.model']);
      expect(chats.length).toBeGreaterThan(0);
      for (const chat of chats) {
        expect(chat['gen_ai.provider.name']).toBe('anthropic');
        expect(chat['gen_ai.response.model']).toMatch(/^claude-/);
      }
    }
  });

  it('keep the replaced stub recordings under recordings/stub, labelled as stub', () => {
    for (const path of ['recordings/stub/cases/03-the-quiet-understudy/trace.jsonl', 'recordings/stub/corpus/control/c01-ferry-live.jsonl']) {
      const trace = readTrace(join(root, path));
      expect(trace.header?.recording).toBe('stub');
      expect(trace.header?.note).toMatch(/^STUB RECORDING/);
      for (const chat of trace.events.filter((event) => event['gen_ai.operation.name'] === 'chat' && event['gen_ai.response.model'])) expect(chat['gen_ai.response.model']).toMatch(/^stub\//);
    }
    expect(readFileSync(join(root, 'recordings/stub/README.md'), 'utf8')).toMatch(/^# Stub recordings \(reference only\)/);
  });

  it('give the ferry case about four hundred lines', () => {
    const lines = readFileSync(join(root, 'cases/03-the-quiet-understudy/trace.jsonl'), 'utf8').trim().split('\n');
    expect(lines.length).toBeGreaterThan(360);
    expect(lines.length).toBeLessThan(440);
  });
});

describe('live recording plan', () => {
  it('resolves targets by number, id, control and all', () => {
    expect(resolveTargets('3').map((target) => target.id)).toEqual(['03-the-quiet-understudy']);
    expect(resolveTargets('06,control').map((target) => target.id)).toEqual(['06-the-marked-paper', 'control']);
    expect(resolveTargets('all')).toHaveLength(TARGETS.length);
    expect(() => resolveTargets('11')).toThrow(/No recordable target/);
  });

  it('estimates calls and tokens from the stub run without spending anything', async () => {
    const [incident] = resolveTargets('03')[0]?.recordings ?? [];
    if (!incident) throw new Error('no case 3 recording');
    const row = await planRecording(incident);
    expect(row.calls).toBeGreaterThan(100);
    expect(row.inputTokens).toBeGreaterThan(row.outputTokens);
    expect(row.uncachedUsd).toBeGreaterThan(0);
    expect(row.uncachedUsd).toBeLessThan(1);
    expect(formatPlan([row], 0)).toMatch(/Ledger so far: \$0\.0000 of the \$30 hard stop/);
  });
});
