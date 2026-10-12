/**
 * The cost ledger. Every live response's `usage` is priced at list price and appended to
 * recordings/spend.jsonl with the model id and a running total. The total is re-read from the
 * file before every call, so separate recording processes share one budget.
 *
 * HARD_STOP_USD is a constant on purpose: there is no flag, environment variable or option
 * that raises it. A call is refused if the total plus a worst-case price for that call would
 * pass the stop, and the process exits if a recorded total ever does.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { repoRoot } from '../src/util/root.js';
import type { MessagesClient, MessagesRequest, MessagesResponse } from './client.js';
import { aliasId } from './live.js';
import { costUsd, rateCard, type UsageLike } from './pricing.js';
import { requestTokens } from './stub.js';

export const HARD_STOP_USD = 30;
export const LEDGER_FILE = join('recordings', 'spend.jsonl');
/** The Haiku 5.5 tokenizer counts about 30% more tokens than the four-characters rule assumes. */
const TOKENIZER_MARGIN = 1.3;

export interface LedgerEntry {
  at: string;
  label: string;
  model: string;
  response_model: string;
  response_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cost_usd: number;
  total_usd: number;
}

export interface LedgerOptions {
  /** Defaults to recordings/spend.jsonl in the repo. Tests pass a temporary file. */
  path?: string;
  now?: () => Date;
  /** Defaults to printing the reason and exiting with status 3. Tests capture it instead. */
  abort?: (reason: string) => never;
}

function exitProcess(reason: string): never {
  console.error(`LEDGER HARD STOP: ${reason}`);
  process.exit(3);
}

const round = (value: number): number => Math.round(value * 1e6) / 1e6;

export class Ledger {
  readonly path: string;
  private readonly now: () => Date;
  private readonly abort: (reason: string) => never;

  constructor(options: LedgerOptions = {}) {
    this.path = options.path ?? join(repoRoot(), LEDGER_FILE);
    this.now = options.now ?? (() => new Date());
    this.abort = options.abort ?? exitProcess;
  }

  entries(): LedgerEntry[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as LedgerEntry);
  }

  /** Sum of every recorded cost, recomputed from the lines rather than trusted from the last total. */
  total(): number {
    return round(this.entries().reduce((sum, entry) => sum + entry.cost_usd, 0));
  }

  /** Worst case for one call: every prompt token uncached, every output token used. */
  worstCase(request: MessagesRequest): number {
    const prompt = Math.ceil(requestTokens(request) * TOKENIZER_MARGIN);
    const card = rateCard(request.model, prompt);
    return (prompt * card.inputPerMillion + request.max_tokens * card.outputPerMillion) / 1_000_000;
  }

  /** Refuses the call (and ends the process) if it could take the total past the hard stop. */
  assertHeadroom(request: MessagesRequest): void {
    const total = this.total();
    const next = this.worstCase(request);
    if (total + next > HARD_STOP_USD) {
      this.abort(`total $${total.toFixed(4)} plus a worst case of $${next.toFixed(4)} for the next call would pass the $${HARD_STOP_USD} stop`);
    }
  }

  charge(label: string, model: string, response: Pick<MessagesResponse, 'id' | 'model'> & { usage: UsageLike }): LedgerEntry {
    const usage = response.usage;
    const cost = costUsd(model, usage);
    const entry: LedgerEntry = {
      at: this.now().toISOString(),
      label,
      model,
      response_model: response.model,
      // Hex alias, like the cassettes: a raw API id can spell a denied term by chance.
      response_id: /^(msg|toolu|id)_[0-9a-f]{24}$/.test(response.id) ? response.id : aliasId(response.id),
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      cost_usd: cost,
      total_usd: round(this.total() + cost),
    };
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
    if (entry.total_usd > HARD_STOP_USD) this.abort(`total $${entry.total_usd.toFixed(4)} passed the $${HARD_STOP_USD} stop`);
    return entry;
  }
}

/** Puts the ledger in front of a client: a headroom check before each call, a charge after. */
export class LedgeredClient implements MessagesClient {
  readonly provider: string;

  constructor(
    private readonly inner: MessagesClient,
    private readonly ledger: Ledger,
    private readonly label: string,
  ) {
    this.provider = inner.provider;
  }

  async create(request: MessagesRequest): Promise<MessagesResponse> {
    this.ledger.assertHeadroom(request);
    const response = await this.inner.create(request);
    this.ledger.charge(this.label, request.model, response);
    return response;
  }
}
