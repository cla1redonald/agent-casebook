/**
 * One ledgered trial call, for designing scenarios against the live model.
 *
 *   npm run probe -- <request.json> <label>
 *
 * The file holds a rig MessagesRequest (model, max_tokens, system, messages, tools). The call
 * goes through the real adapter behind the ledger, so trials count against the same hard stop
 * as recordings. The response is printed redacted, with its usage and cost.
 */
import { readFileSync } from 'node:fs';
import { loadTerms } from '../scripts/check-terms.js';
import { repoRoot } from '../src/util/root.js';
import { AnthropicMessagesClient } from './anthropic.js';
import type { MessagesRequest } from './client.js';
import { Ledger, LedgeredClient } from './ledger.js';
import { Redactor } from './live.js';
import { costUsd } from './pricing.js';

const [file, label] = process.argv.slice(2);
if (!file || !label) {
  console.error('Usage: npm run probe -- <request.json> <label>');
  process.exit(2);
}
const request = JSON.parse(readFileSync(file, 'utf8')) as MessagesRequest;
const ledger = new Ledger();
const client = new LedgeredClient(AnthropicMessagesClient.fromEnv(), ledger, `trial: ${label}`);
const response = new Redactor(loadTerms(process.env, repoRoot()).terms).response(await client.create(request));
console.log(JSON.stringify({ stop_reason: response.stop_reason, content: response.content, usage: response.usage, stop_details: response.stop_details }, null, 2));
console.log(`cost $${costUsd(request.model, response.usage).toFixed(6)}; ledger total $${ledger.total().toFixed(4)}`);
