/**
 * The subset of the Anthropic Messages API shape the rig uses. The stub and the real
 * SDK adapter both satisfy MessagesClient, so the agent loop never knows which it has.
 */
export interface TextBlock {
  type: 'text';
  text: string;
}
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}
export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
export type AssistantBlock = TextBlock | ToolUseBlock;
export type ContentBlock = AssistantBlock | ToolResultBlock;

export interface Message {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface MessagesRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: Message[];
  tools?: ToolSpec[];
}

export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'pause_turn'
  | 'refusal'
  | 'model_context_window_exceeded';

export interface Usage {
  /** Uncached input tokens, billed at the full input rate. */
  input_tokens: number;
  output_tokens: number;
  /** Prompt tokens read from the prompt cache. Absent on stub responses. */
  cache_read_input_tokens?: number;
  /** Prompt tokens written to the prompt cache. Absent on stub responses. */
  cache_creation_input_tokens?: number;
}

/** Present when stop_reason is refusal: the safety classifier's category, if it names one. */
export interface StopDetails {
  category: string | null;
  explanation: string | null;
}

export interface MessagesResponse {
  id: string;
  model: string;
  content: AssistantBlock[];
  stop_reason: StopReason | null;
  usage: Usage;
  stop_details?: StopDetails;
}

export interface MessagesClient {
  /** Provider name recorded as gen_ai.provider.name. */
  readonly provider: string;
  create(request: MessagesRequest): Promise<MessagesResponse>;
}

/** Raised by clients for HTTP-level failures so retry and trace code can read the status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function textOf(content: Message['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) => (block.type === 'text' ? block.text : block.type === 'tool_result' ? block.content : ''))
    .join('\n');
}
