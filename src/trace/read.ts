import { readFileSync } from 'node:fs';
import { traceEventSchema, traceHeaderSchema, type Trace, type TraceEvent } from './schema.js';

export class TraceParseError extends Error {
  constructor(
    readonly file: string,
    readonly line: number,
    detail: string,
  ) {
    super(`${file}:${line}: ${detail}`);
  }
}

/** Parses JSONL text. The header line is optional so readers can sweep their own traces. */
export function parseTrace(text: string, file = '<memory>'): Trace {
  let header: Trace['header'] = null;
  const events: TraceEvent[] = [];
  const lines = text.split('\n');
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (line === '') return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new TraceParseError(file, index + 1, 'not valid JSON');
    }
    if (typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'header') {
      const parsed = traceHeaderSchema.safeParse(value);
      if (!parsed.success) throw new TraceParseError(file, index + 1, `bad header: ${parsed.error.issues[0]?.message}`);
      header = parsed.data;
      return;
    }
    const parsed = traceEventSchema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new TraceParseError(file, index + 1, `bad event: ${issue?.path.join('.')} ${issue?.message}`);
    }
    events.push(parsed.data);
  });
  return { header, events };
}

export function readTrace(file: string): Trace {
  return parseTrace(readFileSync(file, 'utf8'), file);
}

/** Groups events by trace id, keeping file order inside each group. */
export function byTraceId(events: readonly TraceEvent[]): Map<string, TraceEvent[]> {
  const groups = new Map<string, TraceEvent[]>();
  for (const event of events) {
    const group = groups.get(event.trace_id) ?? [];
    group.push(event);
    groups.set(event.trace_id, group);
  }
  return groups;
}
