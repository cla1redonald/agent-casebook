import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MessagesClient, MessagesRequest, MessagesResponse } from './client.js';
import { HARD_STOP_USD, Ledger, LedgeredClient, type LedgerEntry } from './ledger.js';

class Aborted extends Error {}

function ledgerAt(lines: Partial<LedgerEntry>[] = []): { ledger: Ledger; path: string } {
  const path = join(mkdtempSync(join(tmpdir(), 'casebook-ledger-')), 'spend.jsonl');
  if (lines.length > 0) writeFileSync(path, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  const ledger = new Ledger({
    path,
    now: () => new Date('2026-10-12T09:00:00Z'),
    abort: (reason) => {
      throw new Aborted(reason);
    },
  });
  return { ledger, path };
}

const request: MessagesRequest = { model: 'claude-haiku-5-5', max_tokens: 1024, system: 'Be brief.', messages: [{ role: 'user', content: 'hi' }] };
const response = (usage: MessagesResponse['usage']): MessagesResponse => ({ id: 'msg_x', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage });

describe('Ledger', () => {
  it('stops at $30, and the stop is a constant', () => {
    expect(HARD_STOP_USD).toBe(30);
  });

  it('prices each response, appends it with the model id and keeps a running total', () => {
    const { ledger, path } = ledgerAt();
    ledger.charge('03 incident take 1', 'claude-haiku-5-5', response({ input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 }));
    const second = ledger.charge('03 incident take 1', 'claude-sonnet-5-5', response({ input_tokens: 1000, output_tokens: 100 }));
    const lines = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as LedgerEntry);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ model: 'claude-haiku-5-5', cost_usd: 0.00022, total_usd: 0.00022, cache_read_input_tokens: 2000, at: '2026-10-12T09:00:00.000Z' });
    expect(second).toMatchObject({ model: 'claude-sonnet-5-5', cost_usd: 0.003, total_usd: 0.00322 });
    expect(ledger.total()).toBe(0.00322);
    expect(lines[0]?.response_id).toMatch(/^msg_[0-9a-f]{24}$/);
  });

  it('recomputes the total from the costs, not from the last line', () => {
    const { ledger } = ledgerAt([{ cost_usd: 1.5, total_usd: 0 }, { cost_usd: 2.25, total_usd: 0 }]);
    expect(ledger.total()).toBe(3.75);
  });

  it('aborts when a charge takes the total past the stop', () => {
    const { ledger } = ledgerAt([{ cost_usd: 29.9999 }]);
    expect(() => ledger.charge('x', 'claude-sonnet-5-5', response({ input_tokens: 1000, output_tokens: 1000 }))).toThrow(Aborted);
  });

  it('refuses a call whose worst case would pass the stop, before it is made', () => {
    const { ledger } = ledgerAt([{ cost_usd: 29.999 }]);
    expect(() => ledger.assertHeadroom({ ...request, model: 'claude-sonnet-5-5', max_tokens: 4096 })).toThrow(/would pass the \$30 stop/);
    const { ledger: roomy } = ledgerAt([{ cost_usd: 1 }]);
    expect(() => roomy.assertHeadroom(request)).not.toThrow();
  });
});

describe('LedgeredClient', () => {
  it('checks headroom before each call and charges after it', async () => {
    const { ledger } = ledgerAt();
    let calls = 0;
    const inner: MessagesClient = {
      provider: 'anthropic',
      create: async () => {
        calls += 1;
        return response({ input_tokens: 500, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 600 });
      },
    };
    const client = new LedgeredClient(inner, ledger, 'label');
    expect(client.provider).toBe('anthropic');
    await client.create(request);
    await client.create(request);
    expect(calls).toBe(2);
    expect(ledger.entries().map((entry) => entry.label)).toEqual(['label', 'label']);
    expect(ledger.total()).toBe(0.0003);
  });

  it('never reaches the provider once the stop is hit', async () => {
    const { ledger } = ledgerAt([{ cost_usd: 30 }]);
    let calls = 0;
    const inner: MessagesClient = { provider: 'anthropic', create: async () => ((calls += 1), response({ input_tokens: 1, output_tokens: 1 })) };
    await expect(new LedgeredClient(inner, ledger, 'x').create(request)).rejects.toThrow(Aborted);
    expect(calls).toBe(0);
  });
});
