/**
 * List prices in US dollars per million tokens, from the claude-api skill's model catalogue
 * (checked 12 October 2026). Cache writes use the 5-minute TTL rate, 1.25 times base input.
 */
export interface RateCard {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  cacheWritePerMillion: number;
}

export interface Price extends RateCard {
  /** A second rate card for prompts longer than the threshold (Haiku 5.5 only). */
  longContext?: RateCard & { thresholdTokens: number };
}

export const PRICES: Record<string, Price> = {
  'claude-haiku-5-5': {
    inputPerMillion: 0.1,
    outputPerMillion: 0.5,
    cacheReadPerMillion: 0.01,
    cacheWritePerMillion: 0.125,
    longContext: { thresholdTokens: 100_000, inputPerMillion: 0.5, outputPerMillion: 2.5, cacheReadPerMillion: 0.05, cacheWritePerMillion: 0.625 },
  },
  'claude-sonnet-5-5': { inputPerMillion: 2, outputPerMillion: 10, cacheReadPerMillion: 0.2, cacheWritePerMillion: 2.5 },
};

export const PRICE_BASIS =
  'notional, at $2 input and $10 output per million tokens (Sonnet 5.5 planning price); no paid call was made';

export const LIVE_PRICE_BASIS =
  'list price from the usage block of each response: Haiku 5.5 $0.10 input, $0.50 output, $0.01 cache read, $0.125 cache write per million tokens ' +
  '(above 100,000 prompt tokens $0.50, $2.50, $0.05, $0.625); Sonnet 5.5 $2, $10, $0.20, $2.50';

export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Total prompt size: uncached input plus what was read from and written to the cache. */
export function promptTokens(usage: UsageLike): number {
  return usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
}

export function rateCard(model: string, prompt: number): RateCard {
  const price = PRICES[model];
  if (!price) throw new Error(`No price for model ${model}`);
  return price.longContext && prompt > price.longContext.thresholdTokens ? price.longContext : price;
}

export function costUsd(model: string, usage: UsageLike): number {
  const card = rateCard(model, promptTokens(usage));
  const cost =
    (usage.input_tokens * card.inputPerMillion +
      usage.output_tokens * card.outputPerMillion +
      (usage.cache_read_input_tokens ?? 0) * card.cacheReadPerMillion +
      (usage.cache_creation_input_tokens ?? 0) * card.cacheWritePerMillion) /
    1_000_000;
  return Math.round(cost * 1e6) / 1e6;
}
