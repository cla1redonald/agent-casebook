import type { TraceEvent } from '../../src/trace/schema.js';
import type { DetectorMeta, Finding } from '../types.js';

export const meta: DetectorMeta = {
  id: 'd09',
  slug: 'silent-empty-listing',
  title: 'Silent empty listing',
  case: '09-the-empty-cabinet',
  status: 'implemented',
  rule:
    'A listing tool that returns an empty result with no error, where the connector lacks the folder in its granted scope or the same path listed files elsewhere in the sweep, is reported.',
  blindSpots: [
    'A folder that really is empty on first use, inside the granted scope, looks the same.',
    'Connectors that do not record their granted scopes (`connector.allowed_roots`) leave only the history check.',
    'The empty result is read from the span preview: a listing format other than a JSON `files`, `items` or `entries` array is not recognised.',
  ],
};

const LISTING_TOOL = /list|folder|director|files/i;
const EMPTY = /"(files|items|entries)"\s*:\s*\[\s*\]/;
const NON_EMPTY = /"(files|items|entries)"\s*:\s*\[\s*"/;

function pathOf(event: TraceEvent): string | undefined {
  const value = event.attributes?.['connector.path'];
  return typeof value === 'string' ? value : undefined;
}

function rootsOf(event: TraceEvent): string[] | undefined {
  const value = event.attributes?.['connector.allowed_roots'];
  if (typeof value === 'string') return value.split(';').filter(Boolean);
  return Array.isArray(value) ? value : undefined;
}

/** Detects listings that came back empty, with no error, where the connector could not see the folder. */
export function detect(events: readonly TraceEvent[]): Finding[] {
  const listings = events.filter((event) => event['gen_ai.operation.name'] === 'execute_tool' && LISTING_TOOL.test(event['gen_ai.tool.name'] ?? event.name));
  const listedWithFiles = new Set(listings.filter((event) => !event['error.type'] && NON_EMPTY.test(event.preview ?? '')).flatMap((event) => pathOf(event) ?? []));
  const findings: Finding[] = [];
  for (const event of listings) {
    if (event['error.type'] !== undefined || !EMPTY.test(event.preview ?? '')) continue;
    const path = pathOf(event);
    const roots = rootsOf(event);
    const outOfScope = path !== undefined && roots !== undefined && !roots.some((root) => path === root || path.startsWith(`${root}/`));
    const listedElsewhere = path !== undefined && listedWithFiles.has(path);
    if (!outOfScope && !listedElsewhere) continue;
    const parts = [`${event['gen_ai.tool.name'] ?? event.name} returned an empty listing for ${path ?? 'a folder'} with no error.`];
    if (outOfScope) parts.push(`The path is outside the connector's granted roots (${(roots ?? []).join(', ')}): this should have been a permission error.`);
    if (listedElsewhere) parts.push('The same path listed files elsewhere in this sweep.');
    findings.push({ detector: meta.id, severity: 'high', message: parts.join(' '), ev: [event.ev], trace_ids: [event.trace_id] });
  }
  return findings;
}
