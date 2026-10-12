import { ApiError, textOf, type Message, type MessagesClient, type MessagesRequest, type MessagesResponse, type ToolResultBlock } from './client.js';
import type { Clock } from './clock.js';
import type { FaultPlan } from './faults.js';
import { costUsd } from './pricing.js';
import type { Identity, Tool } from './tools.js';
import type { OpenSpan, SpanFields, TraceWriter } from './trace-writer.js';

/** Anything that can wrap a model call with retries. See components/retry.ts. */
export interface RetryRunner {
  run<T>(attempt: () => Promise<T>): Promise<T>;
}

export interface AgentConfig {
  name: string;
  model: string;
  system: string;
  tools: Tool[];
  /** Hard cap on model calls per run, counted here rather than trusted to the model. */
  maxTurns: number;
  maxTokens: number;
  client: MessagesClient;
  clock: Clock;
  trace: TraceWriter;
  faults: FaultPlan;
  retry?: RetryRunner;
  /** Picks the model per call. Defaults to `model`. */
  selectModel?: (messages: Message[]) => string;
}

export interface RunInput {
  traceId: string;
  parentSpanId?: string;
  identity: Identity;
  messages: Message[];
  /** Extra fields for the invoke_agent span, such as deployment.environment.name. */
  fields?: SpanFields;
}

export type Outcome = 'end_turn' | 'stop_sequence' | 'refusal' | 'max_tokens' | 'turn_limit' | 'context_exceeded' | 'error';

export interface RunResult {
  outcome: Outcome;
  text: string;
  messages: Message[];
  turns: number;
}

const MAX_CONTINUATIONS = 1;

export async function runAgent(config: AgentConfig, input: RunInput): Promise<RunResult> {
  const { trace } = config;
  const lastInput = input.messages[input.messages.length - 1];
  const attributes = { ...input.fields?.attributes, 'input.preview': lastInput ? textOf(lastInput.content).slice(0, 220) : '' };
  const root = trace.start(`invoke_agent ${config.name}`, 'internal', input.traceId, input.parentSpanId, {
    'gen_ai.operation.name': 'invoke_agent',
    'gen_ai.agent.name': config.name,
    'gen_ai.provider.name': config.client.provider,
    ...input.fields,
    attributes,
  });
  const messages: Message[] = [...input.messages];
  let turns = 0;
  let continuations = 0;
  let outcome: Outcome | null = null;
  let finalText = '';

  while (outcome === null) {
    if (turns >= config.maxTurns) {
      outcome = 'turn_limit';
      break;
    }
    turns += 1;
    const model = config.selectModel ? config.selectModel(messages) : config.model;
    const request: MessagesRequest = {
      model,
      max_tokens: config.maxTokens,
      system: config.system,
      messages: [...messages],
      tools: config.tools.map((tool) => tool.spec),
    };
    let response: MessagesResponse;
    try {
      response = await callModel(config, root, request);
    } catch {
      outcome = 'error';
      break;
    }
    messages.push({ role: 'assistant', content: response.content });
    const text = response.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
    if (text) finalText = text;

    switch (response.stop_reason) {
      case 'tool_use':
        messages.push({ role: 'user', content: await runTools(config, input.identity, root, response) });
        break;
      case 'pause_turn':
        // The server paused a long turn. Send the conversation back unchanged so it resumes.
        break;
      case 'max_tokens': {
        const cutMidTool = response.content.some((block) => block.type === 'tool_use');
        if (!cutMidTool && continuations < MAX_CONTINUATIONS) {
          continuations += 1;
          messages.push({ role: 'user', content: 'Continue from exactly where you stopped.' });
        } else {
          outcome = 'max_tokens';
        }
        break;
      }
      case 'end_turn':
      case 'stop_sequence':
      case 'refusal':
        outcome = response.stop_reason;
        break;
      case 'model_context_window_exceeded':
        outcome = 'context_exceeded';
        break;
      case null:
        outcome = 'error';
        break;
      default: {
        const unreachable: never = response.stop_reason;
        throw new Error(`Unhandled stop reason ${String(unreachable)}`);
      }
    }
  }

  trace.end(root, {
    ...(outcome === 'end_turn' || outcome === 'stop_sequence' ? {} : { 'error.type': outcome }),
    attributes: { ...attributes, 'agent.turns': turns, 'agent.outcome': outcome },
    ...trace.content(finalText),
  });
  return { outcome, text: finalText, messages, turns };
}

async function callModel(config: AgentConfig, root: OpenSpan, request: MessagesRequest): Promise<MessagesResponse> {
  const attempt = async (): Promise<MessagesResponse> => {
    const span = config.trace.start(`chat ${request.model}`, 'client', root.traceId, root.spanId, {
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': config.client.provider,
      'gen_ai.request.model': request.model,
    });
    try {
      const response = await config.client.create(request);
      const { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } = response.usage;
      // Stub responses carry no cache fields, so stub recordings keep their Phase 3a shape.
      const attributes: Record<string, string | number> = {};
      if (cache_read_input_tokens !== undefined || cache_creation_input_tokens !== undefined) {
        attributes['anthropic.usage.cache_read_input_tokens'] = cache_read_input_tokens ?? 0;
        attributes['anthropic.usage.cache_creation_input_tokens'] = cache_creation_input_tokens ?? 0;
      }
      if (response.stop_details) attributes['stop_details.category'] = response.stop_details.category ?? 'none';
      const text = response.content
        .map((block) => (block.type === 'text' ? block.text : `[tool_use ${block.name} ${JSON.stringify(block.input)}]`))
        .join(' ');
      config.trace.end(span, {
        'gen_ai.response.model': response.model,
        'gen_ai.response.finish_reasons': [response.stop_reason ?? 'null'],
        'gen_ai.usage.input_tokens': input_tokens,
        'gen_ai.usage.output_tokens': output_tokens,
        cost_usd: costUsd(request.model, response.usage),
        ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
        ...config.trace.content(text),
      });
      return response;
    } catch (error) {
      const status = error instanceof ApiError ? error.status : undefined;
      config.trace.end(span, {
        'error.type': status !== undefined ? String(status) : 'exception',
        ...(status !== undefined ? { 'http.status': status } : {}),
      });
      throw error;
    }
  };
  return config.retry ? config.retry.run(attempt) : attempt();
}

async function runTools(config: AgentConfig, identity: Identity, root: OpenSpan, response: MessagesResponse): Promise<ToolResultBlock[]> {
  const results: ToolResultBlock[] = [];
  for (const block of response.content) {
    if (block.type !== 'tool_use') continue;
    const span = config.trace.start(`execute_tool ${block.name}`, 'internal', root.traceId, root.spanId, {
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': block.name,
      'gen_ai.tool.call.id': block.id,
    });
    const tool = config.tools.find((candidate) => candidate.name === block.name);
    const outcome = tool
      ? await tool.invoke(block.input, {
          identity,
          clock: config.clock,
          trace: config.trace,
          traceId: root.traceId,
          spanId: span.spanId,
          faults: config.faults,
        })
      : { content: `Unknown tool ${block.name}.`, isError: true, errorType: 'unknown_tool' };
    config.trace.end(span, {
      ...(outcome.errorType ? { 'error.type': outcome.errorType } : {}),
      ...(outcome.source ? { source: outcome.source } : {}),
      ...(outcome.attributes ? { attributes: outcome.attributes } : {}),
      ...config.trace.content(outcome.content),
    });
    results.push({ type: 'tool_result', tool_use_id: block.id, content: outcome.content, ...(outcome.isError ? { is_error: true } : {}) });
  }
  return results;
}
