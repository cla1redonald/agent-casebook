import Anthropic from '@anthropic-ai/sdk';
import { ApiError, type AssistantBlock, type MessagesClient, type MessagesRequest, type MessagesResponse } from './client.js';

/** The part of the SDK this adapter touches, so tests can supply a fake without a key. */
export interface SdkLike {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

/**
 * How the rig calls the API. Every choice follows the claude-api skill (12 October 2026):
 *
 * - Prompt caching: an explicit breakpoint on the system block, which caches the tool
 *   definitions and the system prompt together (render order is tools, system, messages),
 *   plus top-level automatic caching for the growing conversation tail. The stable prefix
 *   (tools, then system) comes first and contains nothing that varies per request.
 * - Strict tools: `strict: true` on every tool, with a schema reduced to the subset strict
 *   mode accepts. The rig still validates every input with Zod before a tool runs.
 * - Thinking off at low effort. Haiku 5.5 thinks by default; `disabled` is accepted at effort
 *   low, medium and high. Sonnet 5.5 (case 7's large route) takes `between_tools` instead. With
 *   thinking off there are no thinking blocks to carry back, so the rig's append-only history
 *   never trips the history-editing check.
 */
export interface AdapterOptions {
  cache: boolean;
  strictTools: boolean;
  effort: 'low' | 'medium' | 'high';
  thinking: 'disabled' | 'adaptive';
}

export const LIVE_OPTIONS: AdapterOptions = { cache: true, strictTools: true, effort: 'low', thinking: 'disabled' };

/** Real adapter over @anthropic-ai/sdk. */
export class AnthropicMessagesClient implements MessagesClient {
  readonly provider = 'anthropic';

  constructor(
    private readonly sdk: SdkLike,
    private readonly options: AdapterOptions = LIVE_OPTIONS,
  ) {}

  /** Reads the key from ANTHROPIC_API_KEY. The key is passed to the SDK and never logged or stored. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env, options: AdapterOptions = LIVE_OPTIONS): AnthropicMessagesClient {
    const credential = env['ANTHROPIC_API_KEY'];
    if (!credential) throw new Error('ANTHROPIC_API_KEY is not set. Live recording needs it; a dry run does not.');
    // SDK retries are off so the rig's own retry policy is the only one in play and every attempt is traced.
    return new AnthropicMessagesClient(new Anthropic({ apiKey: credential, maxRetries: 0, timeout: 120_000 }), options);
  }

  async create(request: MessagesRequest): Promise<MessagesResponse> {
    let message: Anthropic.Message;
    try {
      message = await this.sdk.messages.create(toParams(request, this.options));
    } catch (error) {
      if (error instanceof Anthropic.APIError && typeof error.status === 'number') {
        throw new ApiError(error.status, error.message);
      }
      throw error;
    }
    return fromMessage(message);
  }
}

/** Keywords strict tool use does not accept. Zod still enforces them before the tool runs. */
const UNSUPPORTED_KEYWORDS = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems', '$schema']);

/** Reduces a JSON schema to what strict tool use accepts: no numeric or length constraints, closed objects. */
export function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (typeof schema !== 'object' || schema === null) return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) continue;
    out[key] = key === 'properties' && typeof value === 'object' && value !== null
      ? Object.fromEntries(Object.entries(value).map(([name, child]) => [name, strictSchema(child)]))
      : strictSchema(value);
  }
  if (out['type'] === 'object') {
    out['additionalProperties'] = false;
    const properties = (out['properties'] ?? {}) as Record<string, unknown>;
    out['properties'] = properties;
    out['required'] = Array.isArray(out['required']) ? out['required'] : Object.keys(properties);
  }
  return out;
}

export function toParams(request: MessagesRequest, options: AdapterOptions = LIVE_OPTIONS): Anthropic.MessageCreateParamsNonStreaming {
  const tools = request.tools?.map((tool): Anthropic.Tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: {
      ...((options.strictTools ? strictSchema(tool.input_schema) : tool.input_schema) as Record<string, unknown>),
      type: 'object' as const,
    },
    ...(options.strictTools ? { strict: true } : {}),
  }));
  return {
    model: request.model,
    max_tokens: request.max_tokens,
    ...(request.system
      ? {
          system: options.cache
            ? [{ type: 'text' as const, text: request.system, cache_control: { type: 'ephemeral' as const } }]
            : request.system,
        }
      : {}),
    messages: request.messages.map((message) => ({
      role: message.role,
      content:
        typeof message.content === 'string'
          ? message.content
          : message.content.map((block): Anthropic.ContentBlockParam => {
              if (block.type === 'text') return { type: 'text', text: block.text };
              if (block.type === 'tool_use') return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
              return {
                type: 'tool_result',
                tool_use_id: block.tool_use_id,
                content: block.content,
                is_error: block.is_error ?? false,
              };
            }),
    })),
    ...(tools ? { tools } : {}),
    ...(options.cache ? { cache_control: { type: 'ephemeral' as const } } : {}),
    thinking: thinkingFor(request.model, options),
    output_config: { effort: options.effort },
  };
}

/**
 * Thinking off, per model. Haiku 5.5 accepts `disabled` at effort low to high. Sonnet 5.5
 * rejects `disabled` with a 400; the skill gives `between_tools` (effort high or below) as the
 * way to turn its thinking off.
 */
export function thinkingFor(model: string, options: AdapterOptions): Anthropic.ThinkingConfigParam {
  if (options.thinking === 'adaptive') return { type: 'adaptive' };
  return model.startsWith('claude-sonnet-5-5') ? { type: 'between_tools' } : { type: 'disabled' };
}

export function fromMessage(message: Anthropic.Message): MessagesResponse {
  const content: AssistantBlock[] = [];
  for (const block of message.content) {
    if (block.type === 'text') content.push({ type: 'text', text: block.text });
    else if (block.type === 'tool_use') content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
  }
  const usage = message.usage;
  const details = (message as { stop_details?: { category?: string | null; explanation?: string | null } | null }).stop_details;
  return {
    id: message.id,
    model: message.model,
    content,
    stop_reason: message.stop_reason,
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    },
    ...(message.stop_reason === 'refusal' ? { stop_details: { category: details?.category ?? null, explanation: details?.explanation ?? null } } : {}),
  };
}
