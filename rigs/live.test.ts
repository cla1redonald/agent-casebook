import { describe, expect, it } from 'vitest';
import type { MessagesClient, MessagesRequest, MessagesResponse } from './client.js';
import { SimClock } from './clock.js';
import { aliasId, aliasIds, EM_DASH, readCassette, RecordingClient, Redactor, ReplayClient, ReplayDivergence, requestHash, writeCassette, type Cassette, type CassetteEntry } from './live.js';
import { LIVE_MODEL, toJsonl } from './scenario.js';
import { CONTROL_TRACES } from './scenarios/control.js';

const reply = (text: string, extra: Partial<MessagesResponse> = {}): MessagesResponse => ({
  id: 'msg_fake',
  model: LIVE_MODEL,
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 900, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  ...extra,
});

describe('Redactor', () => {
  it('replaces em dashes with a spaced hyphen and counts them', () => {
    const redactor = new Redactor([]);
    expect(redactor.text(`Running${EM_DASH}with spaces ${EM_DASH} left.`)).toBe('Running - with spaces - left.');
    expect(redactor.emDashes).toBe(2);
  });

  it('withholds whole words that contain a denied term, case-insensitively', () => {
    const redactor = new Redactor(['zorb', 'two words']);
    expect(redactor.text('The Zorbing season and two words here, then unzorbed.')).toBe('The [withheld] season and [withheld] here, then [withheld].');
    expect(redactor.deniedTerms).toBe(3);
  });

  it('redacts tool inputs as well as text', () => {
    const redactor = new Redactor(['zorb']);
    const out = redactor.response({ ...reply('fine'), content: [{ type: 'tool_use', id: 't', name: 'x', input: { product: 'zorb rolls', count: 2 } }] });
    expect(out.content[0]).toEqual({ type: 'tool_use', id: 't', name: 'x', input: { product: '[withheld] rolls', count: 2 } });
  });
});

describe('aliasId', () => {
  it('replaces API ids with a stable prefix and 24 hex characters, which cannot spell a denied term', () => {
    const alias = aliasId('toolu_01AbCdEfGhIjKlMnOpQrStUv');
    expect(alias).toMatch(/^toolu_[0-9a-f]{24}$/);
    expect(aliasId('toolu_01AbCdEfGhIjKlMnOpQrStUv')).toBe(alias);
    expect(aliasId('msg_01Zz')).toMatch(/^msg_[0-9a-f]{24}$/);
  });

  it('aliases the message id and every tool call id, and nothing else', () => {
    const out = aliasIds({ ...reply('text'), id: 'msg_x', content: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'toolu_y', name: 'n', input: { a: 1 } }] });
    expect(out.id).toBe(aliasId('msg_x'));
    expect(out.content).toEqual([{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: aliasId('toolu_y'), name: 'n', input: { a: 1 } }]);
  });
});

describe('RecordingClient and ReplayClient', () => {
  const request: MessagesRequest = { model: LIVE_MODEL, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] };

  it('measure wall-clock latency, advance the rig clock and play the same responses back', async () => {
    const clock = new SimClock(0);
    let wall = 1000;
    const inner: MessagesClient = { provider: 'anthropic', create: async () => ((wall += 850), reply(`Yes${EM_DASH}running.`)) };
    const recorder = new RecordingClient(inner, clock, new Redactor([]), [], () => wall);
    const live = await recorder.create(request);
    expect(live.content).toEqual([{ type: 'text', text: 'Yes - running.' }]);
    expect(clock.now()).toBe(850);
    expect(recorder.entries[0]).toMatchObject({ seq: 1, latency_ms: 850, request_sha256: requestHash(request) });

    const replayClock = new SimClock(0);
    const progress = { calls: 0 };
    const replayer = new ReplayClient(recorder.entries, replayClock, 'test', progress);
    expect(await replayer.create(request)).toEqual(live);
    expect(replayClock.now()).toBe(850);
    expect(replayer.finished()).toBe(true);
  });

  it('keep a failed call in the cassette and raise the same error on replay', async () => {
    const { ApiError } = await import('./client.js');
    const inner: MessagesClient = {
      provider: 'anthropic',
      create: async () => {
        throw new ApiError(529, 'overloaded');
      },
    };
    const recorder = new RecordingClient(inner, new SimClock(0), new Redactor([]));
    await expect(recorder.create(request)).rejects.toMatchObject({ status: 529 });
    expect(recorder.entries[0]?.error).toEqual({ status: 529, message: 'overloaded' });
    await expect(new ReplayClient(recorder.entries, new SimClock(0), 'test').create(request)).rejects.toMatchObject({ status: 529 });
  });

  it('fail loudly when the rig sends a different request or one too many', async () => {
    const entries: CassetteEntry[] = [{ seq: 1, request_sha256: requestHash(request), latency_ms: 5, response: reply('ok') }];
    const replayer = new ReplayClient(entries, new SimClock(0), 'test');
    await expect(replayer.create({ ...request, max_tokens: 11 })).rejects.toThrow(ReplayDivergence);
    await replayer.create(request);
    await expect(replayer.create(request)).rejects.toThrow(/more calls than the cassette/);
  });
});

describe('a live take through a real scenario', () => {
  it('renders byte for byte the same from its cassette, labelled live', async () => {
    const control = CONTROL_TRACES.find((trace) => trace.name === 'c07-distillery-tours');
    if (!control) throw new Error('missing control trace');
    let calls = 0;
    const fakeLive: MessagesClient = { provider: 'anthropic', create: async () => ((calls += 1), reply(`There are places on both tours${EM_DASH}book at the desk.`)) };
    const redactor = new Redactor([]);
    const sink: CassetteEntry[] = [];
    const live = await control.record({ kind: 'live', client: fakeLive, redactor, take: 1, recordedOn: '2026-10-12', sink });
    expect(calls).toBe(sink.length);

    const cassette: Cassette = {
      meta: { kind: 'cassette', format: 'whodunnit-cassette/1', case: 'control/c07-distillery-tours', variant: 'control', model: LIVE_MODEL, recorded_on: '2026-10-12', rig_version: '0.2.0', take: 1, redactions: { em_dashes: redactor.emDashes, denied_terms: 0 } },
      entries: sink,
    };
    const progress = { calls: 0 };
    const replayed = await control.record({ kind: 'replay', cassette, progress });
    expect(progress.calls).toBe(sink.length);
    expect(toJsonl(replayed)).toBe(toJsonl(live));

    expect(live.header.recording).toBe('live');
    expect(live.header.model).toBe(LIVE_MODEL);
    expect(live.header.clock).toBe('mixed');
    expect(live.header.recorded_on).toBe('2026-10-12');
    expect(live.header.note).toMatch(/^LIVE RECORDING\./);
    expect(live.header.redactions.map((redaction) => redaction.method).join(' ')).toMatch(/6 em dash/);
    const chats = live.events.filter((event) => event['gen_ai.operation.name'] === 'chat');
    expect(chats.every((event) => event['gen_ai.provider.name'] === 'anthropic' && event['gen_ai.response.model'] === LIVE_MODEL)).toBe(true);
    expect(chats[0]?.attributes?.['anthropic.usage.cache_read_input_tokens']).toBe(0);
    expect(toJsonl(live)).not.toContain(EM_DASH);
  });

  it('writes and reads a cassette', () => {
    const cassette: Cassette = {
      meta: { kind: 'cassette', format: 'whodunnit-cassette/1', case: 'c', variant: 'incident', model: LIVE_MODEL, recorded_on: '2026-10-12', rig_version: '0.2.0', take: 2, redactions: { em_dashes: 0, denied_terms: 0 } },
      entries: [{ seq: 1, request_sha256: 'a'.repeat(64), latency_ms: 3, response: reply('ok') }],
    };
    const text = writeCassette(cassette);
    expect(text.trim().split('\n')).toHaveLength(2);
    expect(readCassette('/nonexistent/path.jsonl')).toBeNull();
  });
});
