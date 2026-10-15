import { describe, expect, it } from 'vitest';
import { checkTrace, scanContent } from './check-recordings.js';

const rules = (text: string, secret?: string) => scanContent('f', text, secret).map((finding) => finding.rule);

describe('scanContent', () => {
  it('flags key shapes, bearer values and the live key itself', () => {
    expect(rules(`x ${['sk', 'ant', 'api03', 'abcdefghijkl'].join('-')} y`)).toEqual(['anthropic key shape']);
    expect(rules('Authorization: Bearer abcdefghijklmnopqrstu')).toEqual(['bearer token value']);
    expect(rules('contains s3cr3tvalue here', 's3cr3tvalue')).toEqual(['the live API key']);
  });

  it('allows example.scot and example.invalid addresses and flags any other', () => {
    expect(rules('mail events@craigtarry.example.scot or archive@example.invalid')).toEqual([]);
    expect(rules('mail someone@gmail.test')).toEqual(['email outside example.scot and example.invalid']);
  });

  it('allows the Ofcom drama ranges, flags other numbers, and ignores digits inside ids', () => {
    expect(rules('call 01632 960 418 or 07700 900123')).toEqual([]);
    expect(rules('call 0131 496 0000')).toEqual(['telephone number outside the drama ranges']);
    expect(rules('"trace_id":"9048497d0202321127aee9789419"')).toEqual([]);
  });
});

describe('checkTrace', () => {
  const header = (recording: 'live' | 'stub', note: string) =>
    JSON.stringify({
      kind: 'header',
      format: 'casebook-trace/1',
      semconv: { name: 'x', version: '1.37.0', status: 'Development' },
      case: 'c',
      variant: 'incident',
      recording,
      model: recording === 'live' ? 'claude-haiku-5-5' : 'stub (scripted)',
      recorded_on: '2026-10-12',
      rig_version: '0.2.0',
      clock: recording === 'live' ? 'mixed' : 'simulated',
      epoch: '2026-09-01T06:00:00Z',
      cost_basis: 'x',
      redactions: [],
      note,
    });
  const chat = (model: string) => JSON.stringify({ ev: 'ev-001', t_ms: 0, duration_ms: 5, trace_id: 't', span_id: 's', name: 'chat', 'span.kind': 'client', 'gen_ai.operation.name': 'chat', 'gen_ai.response.model': model });

  it('accepts a correctly labelled live trace and rejects a stub response inside it', () => {
    expect(checkTrace('f', `${header('live', 'LIVE RECORDING. x')}\n${chat('claude-haiku-5-5')}\n`, null)).toEqual([]);
    expect(checkTrace('f', `${header('live', 'LIVE RECORDING. x')}\n${chat('stub/claude-haiku-5-5')}\n`, null).map((finding) => finding.rule)).toEqual(['live trace contains a stub response']);
  });

  it('rejects a live trace whose note does not say so', () => {
    expect(checkTrace('f', `${header('live', 'Recorded.')}\n`, null).map((finding) => finding.rule)).toEqual(['live header note does not say LIVE RECORDING']);
  });

  it('rejects a stub trace that contains an unlabelled response', () => {
    expect(checkTrace('f', `${header('stub', 'STUB RECORDING. x')}\n${chat('claude-haiku-5-5')}\n`, null).map((finding) => finding.rule)).toEqual(['stub trace contains a response not labelled stub']);
  });
});
