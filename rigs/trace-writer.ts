import { createHash } from 'node:crypto';
import type { TraceEvent } from '../src/trace/schema.js';
import type { Clock, Rng } from './clock.js';

type SpanKind = TraceEvent['span.kind'];
/** Fields a caller may set on a span. Identity and timing fields are owned by the writer. */
export type SpanFields = Omit<
  TraceEvent,
  'ev' | 't_ms' | 'duration_ms' | 'trace_id' | 'span_id' | 'parent_span_id' | 'name' | 'span.kind'
>;

export interface OpenSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly seq: number;
  readonly startMs: number;
  readonly name: string;
  readonly kind: SpanKind;
  readonly parentSpanId: string | undefined;
  fields: SpanFields;
}

const PREVIEW_CHARS = 220;

/**
 * Records spans and writes them in the order they started, so a reader sees a session
 * top to bottom. Event ids (ev-001, ev-002, ...) are assigned at the end, in line order.
 */
export class TraceWriter {
  private seq = 0;
  private readonly finished: Array<{ seq: number; event: Omit<TraceEvent, 'ev'> }> = [];
  private readonly open = new Set<OpenSpan>();
  readonly blobs = new Map<string, string>();

  constructor(
    private readonly clock: Clock,
    private readonly ids: Rng,
    private readonly epochMs: number,
    private readonly lockerThreshold = 400,
  ) {}

  newTraceId(): string {
    return this.ids.hex(32);
  }

  start(name: string, kind: SpanKind, traceId: string, parentSpanId?: string, fields: SpanFields = {}): OpenSpan {
    const span: OpenSpan = {
      traceId,
      spanId: this.ids.hex(16),
      seq: this.seq++,
      startMs: this.clock.now(),
      name,
      kind,
      parentSpanId,
      fields: { ...fields },
    };
    this.open.add(span);
    return span;
  }

  end(span: OpenSpan, fields: SpanFields = {}): void {
    if (!this.open.delete(span)) throw new Error(`Span ${span.name} ended twice or was never started.`);
    const merged = { ...span.fields, ...fields };
    this.finished.push({
      seq: span.seq,
      event: {
        t_ms: span.startMs - this.epochMs,
        duration_ms: this.clock.now() - span.startMs,
        trace_id: span.traceId,
        span_id: span.spanId,
        ...(span.parentSpanId ? { parent_span_id: span.parentSpanId } : {}),
        name: span.name,
        'span.kind': span.kind,
        ...merged,
      },
    });
  }

  /** The most recently started span that is still open and whose name starts with the prefix. */
  latestOpen(prefix: string): OpenSpan | undefined {
    let found: OpenSpan | undefined;
    for (const span of this.open) if (span.name.startsWith(prefix) && (!found || span.seq > found.seq)) found = span;
    return found;
  }

  /** Short preview inline; anything longer than the threshold also goes to the locker. */
  content(text: string): Pick<TraceEvent, 'preview' | 'locker'> {
    const preview = text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 3)}...` : text;
    if (text.length <= this.lockerThreshold) return { preview };
    const hash = createHash('sha256').update(text).digest('hex');
    this.blobs.set(hash, text);
    return { preview, locker: `sha256:${hash}` };
  }

  events(): TraceEvent[] {
    if (this.open.size > 0) throw new Error(`${this.open.size} span(s) still open.`);
    const width = Math.max(3, String(this.finished.length).length);
    return [...this.finished]
      .sort((a, b) => a.seq - b.seq)
      .map((record, index) => ({ ev: `ev-${String(index + 1).padStart(width, '0')}`, ...record.event }));
  }
}
