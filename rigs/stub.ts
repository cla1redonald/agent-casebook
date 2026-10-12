import type { AssistantBlock, Message, MessagesClient, MessagesRequest, MessagesResponse, StopReason } from './client.js';
import type { SimClock } from './clock.js';

export interface StubReply {
  content: AssistantBlock[];
  stop_reason: StopReason;
}

export interface StubTurnContext {
  /** Zero-based turn inside the conversation: the number of assistant messages already sent. */
  turn: number;
  request: MessagesRequest;
  /** Allocates a deterministic tool_use id. */
  toolUseId(): string;
}

/** A script of responses keyed by turn. A missing turn ends the conversation. */
export type StubScript = Record<number, (context: StubTurnContext) => StubReply>;

/** Rough token estimate, four characters per token. Good enough for notional costs. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function requestTokens(request: MessagesRequest): number {
  return estimateTokens(JSON.stringify({ s: request.system ?? '', t: request.tools ?? [], m: request.messages }));
}

function assistantTurns(messages: Message[]): number {
  return messages.filter((message) => message.role === 'assistant').length;
}

/**
 * Deterministic stand-in for the Messages API. It advances the simulated clock by a
 * latency derived from token counts, so durations in a stub recording are stable.
 */
export class StubClient implements MessagesClient {
  readonly provider = 'stub';
  private script: StubScript = {};
  private messageCounter = 0;
  private toolCounter = 0;

  constructor(private readonly clock: SimClock) {}

  load(script: StubScript): void {
    this.script = script;
  }

  async create(request: MessagesRequest): Promise<MessagesResponse> {
    const turn = assistantTurns(request.messages);
    const step = this.script[turn];
    const reply: StubReply = step
      ? step({ turn, request, toolUseId: () => `toolu_stub_${String(++this.toolCounter).padStart(4, '0')}` })
      : { content: [{ type: 'text', text: 'There is nothing further I can add.' }], stop_reason: 'end_turn' };
    const inputTokens = requestTokens(request);
    const outputTokens = estimateTokens(JSON.stringify(reply.content));
    this.clock.advance(320 + outputTokens * 14 + Math.round(inputTokens * 0.03));
    return {
      id: `msg_stub_${String(++this.messageCounter).padStart(5, '0')}`,
      // Every response names itself as a stub, so no event can be mistaken for a live recording.
      model: `stub/${request.model}`,
      content: reply.content,
      stop_reason: reply.stop_reason,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    };
  }
}

/** Helpers for writing scripts. */
export const say = (text: string, stop_reason: StopReason = 'end_turn'): StubReply => ({
  content: [{ type: 'text', text }],
  stop_reason,
});

export const callTool = (context: StubTurnContext, name: string, input: unknown, preface?: string): StubReply => ({
  content: [
    ...(preface ? [{ type: 'text' as const, text: preface }] : []),
    { type: 'tool_use' as const, id: context.toolUseId(), name, input },
  ],
  stop_reason: 'tool_use',
});

/** Returns the text of the most recent tool_result in the request, or null. */
export function lastToolResult(request: MessagesRequest): string | null {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const message = request.messages[i];
    if (!message || typeof message.content === 'string') continue;
    for (const block of message.content) if (block.type === 'tool_result') return block.content;
  }
  return null;
}

/** Returns the text of the first user message, which is the customer's question. */
export function firstUserText(request: MessagesRequest): string {
  const first = request.messages.find((message) => message.role === 'user');
  if (!first) return '';
  return typeof first.content === 'string'
    ? first.content
    : first.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
}
