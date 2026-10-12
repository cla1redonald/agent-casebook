/**
 * One-off migration, run once on 12 October 2026 (decision 0002): replaces the ids the API
 * issued (message ids and tool call ids) in recorded cassettes and in the spend ledger with hex
 * aliases (rigs/live.ts aliasId), because random ids can spell a short denied term by chance.
 * Takes recorded after this change alias their ids as they arrive and do not need it.
 *
 * For cassettes the recorder renders, the replacement changes the requests the rig sends on
 * later turns (they quote earlier tool call ids), so the cassette is replayed through the rig to
 * recompute each request hash. Nothing else changes: the responses, latencies and costs are as
 * recorded. Archived cassettes (not reproduced, superseded) get the aliases only; they were made
 * by an earlier version of their scenario and are kept as evidence, not replayed.
 *
 *   node --import tsx scripts/alias-ids.ts
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { aliasId, aliasIds, readCassette, writeCassette, type Cassette } from '../rigs/live.js';
import { cassettePath, TARGETS } from '../rigs/record.js';
import { repoRoot } from '../src/util/root.js';

const ALIASED = /^(msg|toolu|id)_[0-9a-f]{24}$/;
const alias = (id: string) => (ALIASED.test(id) ? id : aliasId(id));

function aliasCassette(cassette: Cassette): number {
  let changed = 0;
  for (const entry of cassette.entries) {
    if (!entry.response) continue;
    const before = JSON.stringify(entry.response);
    const already = ALIASED.test(entry.response.id);
    entry.response = already ? entry.response : aliasIds(entry.response);
    entry.response = { ...entry.response, content: entry.response.content.map((block) => (block.type === 'tool_use' ? { ...block, id: alias(block.id) } : block)) };
    if (JSON.stringify(entry.response) !== before) changed += 1;
  }
  return changed;
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith('.cassette.jsonl') ? [path] : [];
  });
}

const root = repoRoot();
const rendered = new Map(TARGETS.flatMap((target) => target.recordings).map((spec) => [cassettePath(root, spec), spec]));

for (const path of walk(join(root, 'recordings'))) {
  const cassette = readCassette(path);
  if (!cassette) continue;
  const changed = aliasCassette(cassette);
  const spec = rendered.get(path);
  if (spec) {
    const progress = { calls: 0 };
    await spec.record({ kind: 'replay', cassette, progress, rehash: true });
    if (progress.calls !== cassette.entries.length) throw new Error(`${relative(root, path)}: rehash replay used ${progress.calls} of ${cassette.entries.length} calls.`);
  }
  writeFileSync(path, writeCassette(cassette));
  console.log(`${relative(root, path)}: ${changed} response(s) aliased${spec ? ', request hashes recomputed' : ' (archived, not replayed)'}`);
}

const ledgerPath = join(root, 'recordings', 'spend.jsonl');
if (existsSync(ledgerPath)) {
  const lines = readFileSync(ledgerPath, 'utf8').split('\n').filter((line) => line.trim() !== '');
  const out = lines.map((line) => {
    const entry = JSON.parse(line) as { response_id: string };
    return JSON.stringify({ ...entry, response_id: alias(entry.response_id) });
  });
  writeFileSync(ledgerPath, `${out.join('\n')}\n`);
  console.log(`recordings/spend.jsonl: ${out.length} line(s), response ids aliased; costs and totals unchanged`);
}
