import { z } from 'zod';

/** Version of this repo's trace format. Bump on any breaking change. */
export const TRACE_FORMAT = 'casebook-trace/1';

/**
 * The OpenTelemetry semantic conventions release the attribute names were checked against.
 * The GenAI conventions were marked Development upstream when this was written.
 */
export const SEMCONV = {
  name: 'OpenTelemetry semantic conventions (GenAI)',
  version: '1.37.0',
  status: 'Development',
} as const;

export const OPERATION_NAMES = ['chat', 'execute_tool', 'invoke_agent'] as const;
export type OperationName = (typeof OPERATION_NAMES)[number];

const attributeValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);

export const traceHeaderSchema = z.object({
  kind: z.literal('header'),
  format: z.literal(TRACE_FORMAT),
  semconv: z.object({ name: z.string(), version: z.string(), status: z.string() }),
  case: z.string(),
  variant: z.enum(['incident', 'fixed', 'control']),
  recording: z.enum(['stub', 'live']),
  model: z.string(),
  recorded_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rig_version: z.string(),
  // mixed: scripted session start times, measured wall-clock model latency, simulated tool latency.
  clock: z.enum(['simulated', 'wall', 'mixed']),
  epoch: z.string(),
  cost_basis: z.string(),
  redactions: z.array(z.object({ field: z.string(), method: z.string() })),
  note: z.string(),
});
export type TraceHeader = z.infer<typeof traceHeaderSchema>;

/**
 * One span, written when it ends. Dotted keys follow OpenTelemetry names where one exists;
 * `ev`, `t_ms`, `cost_usd`, `source`, `http.status`, `preview` and `locker` are this format's own.
 */
export const traceEventSchema = z.object({
  ev: z.string().regex(/^ev-\d{3,}$/),
  t_ms: z.number().int().nonnegative(),
  duration_ms: z.number().int().nonnegative(),
  trace_id: z.string(),
  span_id: z.string(),
  parent_span_id: z.string().optional(),
  name: z.string(),
  'span.kind': z.enum(['internal', 'client', 'server']),
  'gen_ai.operation.name': z.enum(OPERATION_NAMES).optional(),
  'gen_ai.provider.name': z.string().optional(),
  'gen_ai.agent.name': z.string().optional(),
  'gen_ai.request.model': z.string().optional(),
  'gen_ai.response.model': z.string().optional(),
  'gen_ai.response.finish_reasons': z.array(z.string()).optional(),
  'gen_ai.usage.input_tokens': z.number().int().nonnegative().optional(),
  'gen_ai.usage.output_tokens': z.number().int().nonnegative().optional(),
  'gen_ai.tool.name': z.string().optional(),
  'gen_ai.tool.call.id': z.string().optional(),
  'deployment.environment.name': z.string().optional(),
  'http.request.method': z.string().optional(),
  'http.route': z.string().optional(),
  'url.full': z.string().optional(),
  'http.status': z.number().int().optional(),
  'http.request.body.size': z.number().int().nonnegative().optional(),
  'error.type': z.string().optional(),
  cost_usd: z.number().nonnegative().optional(),
  source: z.string().optional(),
  attributes: z.record(z.string(), attributeValue).optional(),
  preview: z.string().optional(),
  locker: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
});
export type TraceEvent = z.infer<typeof traceEventSchema>;

export interface Trace {
  header: TraceHeader | null;
  events: TraceEvent[];
}
