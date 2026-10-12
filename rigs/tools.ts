import { z } from 'zod';
import type { ToolSpec } from './client.js';
import type { Clock } from './clock.js';
import type { FaultPlan } from './faults.js';
import type { TraceWriter } from './trace-writer.js';

/** Who the agent is acting for. Set by the harness, never taken from model output. */
export interface Identity {
  subject: string;
  role: string;
  tenant: string;
}

export interface ToolContext {
  identity: Identity;
  clock: Clock;
  trace: TraceWriter;
  traceId: string;
  /** The execute_tool span, so tools can hang client spans beneath it. */
  spanId: string;
  faults: FaultPlan;
}

export interface ToolOutcome {
  content: string;
  /** Sent to the model as is_error. */
  isError?: boolean;
  /** Recorded on the execute_tool span as error.type. */
  errorType?: string;
  /** Where the data came from, recorded as `source`. */
  source?: string;
  attributes?: Record<string, string | number | boolean>;
}

export interface Tool {
  name: string;
  description: string;
  spec: ToolSpec;
  /** Validates the raw model input against the schema, then executes. */
  invoke(rawInput: unknown, context: ToolContext): Promise<ToolOutcome>;
}

export function defineTool<S extends z.ZodType>(definition: {
  name: string;
  description: string;
  input: S;
  execute: (input: z.output<S>, context: ToolContext) => Promise<ToolOutcome>;
}): Tool {
  const jsonSchema = z.toJSONSchema(definition.input) as Record<string, unknown>;
  delete jsonSchema['$schema'];
  return {
    name: definition.name,
    description: definition.description,
    spec: { name: definition.name, description: definition.description, input_schema: jsonSchema },
    async invoke(rawInput, context) {
      const parsed = definition.input.safeParse(rawInput);
      if (!parsed.success) {
        const detail = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ');
        return { content: `Invalid input for ${definition.name}: ${detail}`, isError: true, errorType: 'invalid_input' };
      }
      return definition.execute(parsed.data, context);
    },
  };
}
