import type { ToolContext, ToolOutcome } from '../tools.js';

export interface UpstreamReply {
  status: number;
  body: string;
  latencyMs: number;
}

/** A simulated upstream service: given the current time, what does it answer? */
export type Upstream = (atMs: number) => UpstreamReply;

/** Makes a simulated HTTP call and records it as a client span under the current tool span. */
export async function httpCall(context: ToolContext, method: string, url: string, upstream: Upstream): Promise<UpstreamReply> {
  const span = context.trace.start(`${method} ${new URL(url).pathname}`, 'client', context.traceId, context.spanId, {
    'http.request.method': method,
    'url.full': url,
  });
  const reply = upstream(context.clock.now());
  context.clock.advance(reply.latencyMs);
  context.trace.end(span, {
    'http.status': reply.status,
    ...(reply.status >= 500 ? { 'error.type': String(reply.status) } : {}),
    ...context.trace.content(reply.body),
  });
  return reply;
}

export interface Snapshot {
  body: string;
  /** Plain description, for example "the published timetable of 31 August". */
  label: string;
  readLatencyMs: number;
}

/**
 * Calls the live service and falls back to a static snapshot on a 5xx.
 * Correct behaviour: the fallback is marked on the span and announced to the model.
 * Fault upstream_503_silent_fallback: the snapshot is returned as if it were live, status ok.
 */
export async function fetchWithFallback(
  context: ToolContext,
  request: { method: string; url: string; upstream: Upstream; snapshot: Snapshot },
): Promise<ToolOutcome> {
  const reply = await httpCall(context, request.method, request.url, request.upstream);
  if (reply.status < 400) return { content: reply.body, source: 'live' };
  if (reply.status < 500) return { content: `The service refused the request (${reply.status}).`, isError: true, errorType: String(reply.status) };

  context.clock.advance(request.snapshot.readLatencyMs);
  if (context.faults.active('upstream_503_silent_fallback', context.clock.now())) {
    return { content: request.snapshot.body, source: 'snapshot' };
  }
  const notice =
    `Live data is unavailable (upstream returned ${reply.status}). What follows is ${request.snapshot.label}. ` +
    'It does not show cancellations or remaining capacity. Do not confirm anything from it; tell the customer to check before travelling.';
  return {
    content: JSON.stringify({ notice, snapshot: JSON.parse(request.snapshot.body) as unknown }),
    source: 'snapshot',
    errorType: 'upstream_unavailable',
    attributes: { 'fallback.reason': String(reply.status) },
  };
}
