/**
 * Live recording plumbing.
 *
 * A live take writes a cassette: one line per model call with the hash of the rig's request,
 * the measured latency and the response exactly as the rig received it. Traces are rendered
 * from cassettes by replaying them through the same rig, so `npm run record -- --check` can
 * still prove byte for byte that the committed trace is what the rig produced, without a key
 * and without spending anything. A replay that sends a different request fails loudly.
 *
 * Redaction happens once, as responses arrive, before the rig or the cassette sees them, so the
 * cassette, the trace and the rest of the conversation all carry the same redacted text.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { ApiError, type AssistantBlock, type MessagesClient, type MessagesRequest, type MessagesResponse } from './client.js';
import type { Clock } from './clock.js';

export const CASSETTE_FORMAT = 'casebook-cassette/1';

export interface CassetteMeta {
  kind: 'cassette';
  format: typeof CASSETTE_FORMAT;
  case: string;
  variant: 'incident' | 'fixed' | 'control';
  model: string;
  recorded_on: string;
  rig_version: string;
  take: number;
  /** How many replacements the redactor made, by kind. Never the terms themselves. */
  redactions: { em_dashes: number; denied_terms: number };
}

export interface CassetteEntry {
  seq: number;
  request_sha256: string;
  latency_ms: number;
  /** The response, or the error the call ended in (an API status, or none for a network failure). */
  response?: MessagesResponse;
  error?: { status: number | null; message: string };
}

export function requestHash(request: MessagesRequest): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex');
}

export const EM_DASH = String.fromCharCode(0x2014);

/**
 * Ids the API issues (message ids, tool call ids) are random letters and digits, and can spell a
 * short denied term by chance. Each is replaced by a stable alias: a prefix and 24 hex characters
 * of its SHA-256. Hex uses only the letters a to f, so an alias cannot spell any of the terms.
 */
export function aliasId(id: string): string {
  const prefix = id.startsWith('toolu_') ? 'toolu_' : id.startsWith('msg_') ? 'msg_' : 'id_';
  return `${prefix}${createHash('sha256').update(id).digest('hex').slice(0, 24)}`;
}

export function aliasIds(response: MessagesResponse): MessagesResponse {
  return {
    ...response,
    id: aliasId(response.id),
    content: response.content.map((block) => (block.type === 'tool_use' ? { ...block, id: aliasId(block.id) } : block)),
  };
}
export const WITHHELD = '[withheld]';

/**
 * Replaces em dashes with a spaced hyphen, and any word containing a term from the project's
 * deny list with [withheld]. Matching is case-insensitive and by substring, like the check.
 */
export class Redactor {
  emDashes = 0;
  deniedTerms = 0;

  constructor(private readonly terms: readonly string[]) {}

  text(input: string): string {
    let out = input;
    if (out.includes(EM_DASH)) {
      this.emDashes += out.split(EM_DASH).length - 1;
      out = out.replace(new RegExp(`\\s*${EM_DASH}\\s*`, 'g'), ' - ');
    }
    for (const term of this.terms) {
      for (;;) {
        const index = out.toLowerCase().indexOf(term);
        if (index < 0) break;
        // Widen the match to whole words so no fragment of the term survives.
        let start = index;
        let end = index + term.length;
        while (start > 0 && /[\p{L}\p{N}_'-]/u.test(out[start - 1] ?? '')) start -= 1;
        while (end < out.length && /[\p{L}\p{N}_'-]/u.test(out[end] ?? '')) end += 1;
        out = `${out.slice(0, start)}${WITHHELD}${out.slice(end)}`;
        this.deniedTerms += 1;
      }
    }
    return out;
  }

  value(input: unknown): unknown {
    if (typeof input === 'string') return this.text(input);
    if (Array.isArray(input)) return input.map((item) => this.value(item));
    if (typeof input === 'object' && input !== null) return Object.fromEntries(Object.entries(input).map(([key, child]) => [key, this.value(child)]));
    return input;
  }

  response(response: MessagesResponse): MessagesResponse {
    const content = response.content.map((block): AssistantBlock =>
      block.type === 'text' ? { type: 'text', text: this.text(block.text) } : { ...block, input: this.value(block.input) },
    );
    return { ...response, content };
  }
}

/**
 * Wraps the live client: redacts each response, measures how long the call took on the wall
 * clock, advances the rig's clock by that much and keeps the entry for the cassette.
 */
export class RecordingClient implements MessagesClient {
  readonly provider: string;

  constructor(
    private readonly inner: MessagesClient,
    private readonly clock: Clock,
    private readonly redactor: Redactor,
    readonly entries: CassetteEntry[] = [],
    private readonly wallNow: () => number = () => performance.now(),
  ) {
    this.provider = inner.provider;
  }

  async create(request: MessagesRequest): Promise<MessagesResponse> {
    const started = this.wallNow();
    const elapsed = () => Math.max(1, Math.round(this.wallNow() - started));
    let raw: MessagesResponse;
    try {
      raw = await this.inner.create(request);
    } catch (error) {
      // A real failure is part of the take: keep it so the replay fails at the same point.
      const latency = elapsed();
      const status = error instanceof ApiError ? error.status : null;
      const message = error instanceof Error ? error.message.slice(0, 200) : 'unknown error';
      this.entries.push({ seq: this.entries.length + 1, request_sha256: requestHash(request), latency_ms: latency, error: { status, message: this.redactor.text(message) } });
      this.clock.advance(latency);
      throw error;
    }
    const latency = elapsed();
    const response = aliasIds(this.redactor.response(raw));
    this.entries.push({ seq: this.entries.length + 1, request_sha256: requestHash(request), latency_ms: latency, response });
    this.clock.advance(latency);
    return response;
  }
}

export class ReplayDivergence extends Error {}

/** Plays a cassette back. Each call must send exactly the request that was recorded. */
export class ReplayClient implements MessagesClient {
  readonly provider = 'anthropic';

  constructor(
    private readonly entries: CassetteEntry[],
    private readonly clock: Clock,
    private readonly label: string,
    private readonly progress: { calls: number } = { calls: 0 },
    /** Migration only: record the request hash instead of checking it. */
    private readonly rehash = false,
  ) {}

  async create(request: MessagesRequest): Promise<MessagesResponse> {
    const entry = this.entries[this.progress.calls];
    if (!entry) throw new ReplayDivergence(`${this.label}: the rig made more calls than the cassette holds (${this.entries.length}).`);
    if (this.rehash) entry.request_sha256 = requestHash(request);
    else if (entry.request_sha256 !== requestHash(request)) {
      throw new ReplayDivergence(`${this.label}: call ${entry.seq} sent a different request from the one recorded. Re-record this take.`);
    }
    this.progress.calls += 1;
    this.clock.advance(entry.latency_ms);
    if (entry.error) {
      if (entry.error.status !== null) throw new ApiError(entry.error.status, entry.error.message);
      throw new Error(entry.error.message);
    }
    if (!entry.response) throw new ReplayDivergence(`${this.label}: call ${entry.seq} has neither a response nor an error.`);
    return entry.response;
  }

  /** True when every recorded call was replayed. */
  finished(): boolean {
    return this.progress.calls === this.entries.length;
  }
}

export interface Cassette {
  meta: CassetteMeta;
  entries: CassetteEntry[];
}

export function writeCassette(cassette: Cassette): string {
  return [cassette.meta, ...cassette.entries].map((line) => JSON.stringify(line)).join('\n') + '\n';
}

export function readCassette(path: string): Cassette | null {
  if (!existsSync(path)) return null;
  const [first, ...rest] = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '');
  if (!first) throw new Error(`${path} is empty.`);
  const meta = JSON.parse(first) as CassetteMeta;
  if (meta.kind !== 'cassette' || meta.format !== CASSETTE_FORMAT) throw new Error(`${path} is not a ${CASSETTE_FORMAT} file.`);
  return { meta, entries: rest.map((line) => JSON.parse(line) as CassetteEntry) };
}
