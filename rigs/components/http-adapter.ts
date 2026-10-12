import type { Clock } from '../clock.js';
import type { Identity } from '../tools.js';
import type { SpanFields, TraceWriter } from '../trace-writer.js';

export interface HttpRequest {
  method: string;
  route: string;
  headers: Record<string, string>;
  body: string;
  /** Declared size. Simulated uploads are not materialised, only measured. */
  bodyBytes: number;
}

export interface HttpResponse {
  status: number;
  body: string;
}

export interface HandlerContext {
  /** Set by the adapter from a verified token. Null when the handler is called in-process. */
  identity: Identity | null;
  traceId: string;
  parentSpanId: string | undefined;
}

export type Handler = (request: HttpRequest, context: HandlerContext) => Promise<HttpResponse>;

export interface AdapterOptions {
  maxBodyBytes: number;
  /** Token to identity. Stands in for real token verification. */
  tokens: ReadonlyMap<string, Identity>;
  handler: Handler;
  trace: TraceWriter;
  clock: Clock;
  /** Extra span fields, such as deployment.environment.name. */
  fields?: SpanFields;
}

/** The HTTP edge: enforces body size and authentication, then injects the identity. */
export class HttpAdapter {
  constructor(private readonly options: AdapterOptions) {}

  async handle(request: HttpRequest, traceId: string, parentSpanId?: string): Promise<HttpResponse> {
    const { trace, clock } = this.options;
    const span = trace.start(`${request.method} ${request.route}`, 'server', traceId, parentSpanId, {
      ...this.options.fields,
      'http.request.method': request.method,
      'http.route': request.route,
      'http.request.body.size': request.bodyBytes,
      attributes: { 'http.request.header_names': Object.keys(request.headers).sort() },
    });
    clock.advance(2);
    let response: HttpResponse;
    if (request.bodyBytes > this.options.maxBodyBytes) {
      response = { status: 413, body: 'Request body too large.' };
    } else {
      const token = (request.headers['authorization'] ?? '').replace(/^Bearer /, '');
      const identity = this.options.tokens.get(token) ?? null;
      response = identity
        ? await this.options.handler(request, { identity, traceId, parentSpanId: span.spanId })
        : { status: 401, body: 'Not authenticated.' };
    }
    trace.end(span, { 'http.status': response.status, ...(response.status >= 500 ? { 'error.type': String(response.status) } : {}) });
    return response;
  }
}
