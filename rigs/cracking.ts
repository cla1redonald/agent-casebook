/**
 * The evidence that cracks each recorded case, computed from the recording so event ids never
 * drift. Each group is a set of equivalent event ids; see docs/decisions/0001-phase-3a.md for
 * how accusations are scored against them. The groups go into the sealed solutions only.
 */
import type { TraceEvent } from '../src/trace/schema.js';

export interface CrackingGroup {
  label: string;
  ev: string[];
}

type Blobs = ReadonlyMap<string, string>;
type Cracker = (events: TraceEvent[], blobs: Blobs) => CrackingGroup[];

function ids(events: TraceEvent[]): string[] {
  return events.map((event) => event.ev);
}

/** The span's full output: the locker blob when there is one, else the preview. */
export function fullText(event: TraceEvent, blobs: Blobs): string {
  if (event.locker) return blobs.get(event.locker.slice('sha256:'.length)) ?? event.preview ?? '';
  return event.preview ?? '';
}

function attribute(event: TraceEvent, name: string): unknown {
  return event.attributes?.[name];
}

function headerNames(event: TraceEvent): string[] {
  const value = event.attributes?.['app.request.header_names'];
  return Array.isArray(value) ? value : [];
}

const tool = (events: TraceEvent[], name: string) => events.filter((event) => event['gen_ai.tool.name'] === name && event['gen_ai.operation.name'] === 'execute_tool');
const chats = (events: TraceEvent[]) => events.filter((event) => event['gen_ai.operation.name'] === 'chat');

export const CRACKING: Record<string, Cracker> = {
  '01-the-long-afternoon': (events, blobs) => {
    const compactions = events.filter((event) => event.name === 'compaction' && Number(attribute(event, 'compaction.constraints_kept')) < Number(attribute(event, 'compaction.constraints_in')));
    const at = compactions[0]?.t_ms ?? Infinity;
    const figure = /£\s?\d/;
    return [
      { label: 'the compaction span that kept 0 of the 2 standing constraints; its summary is in the locker', ev: ids(compactions) },
      { label: 'after compaction, model calls whose drafts quote sale figures, ending with the client summary', ev: ids(chats(events).filter((event) => event.t_ms > at && figure.test(fullText(event, blobs)))) },
      { label: 'morning drafts in the same session, on the same model, before compaction, with no figure', ev: ids(chats(events).filter((event) => event.t_ms < at && !figure.test(fullText(event, blobs)))) },
    ];
  },
  '03-the-quiet-understudy': (events) => [
    { label: 'the availability API answered 503 beneath a tool span that reported no error', ev: ids(events.filter((e) => e['http.status'] === 503)) },
    { label: 'check_sailings returned data from source snapshot, in about 12 ms', ev: ids(tool(events, 'check_sailings').filter((e) => e.source === 'snapshot')) },
    { label: 'check_sailings returned live data in about 900 ms before the switch', ev: ids(tool(events, 'check_sailings').filter((e) => e.source === 'live')) },
  ],
  '04-the-eleven-thousand-knocks': (events) => {
    const failed = chats(events).filter((event) => event['error.type'] === '429');
    const byTrace = new Map<string, TraceEvent[]>();
    for (const chat of failed) byTrace.set(chat.trace_id, [...(byTrace.get(chat.trace_id) ?? []), chat]);
    const quick = [...byTrace.values()].flatMap((group) => group.filter((chat, index) => index > 0 && chat.t_ms - ((group[index - 1]?.t_ms ?? 0) + (group[index - 1]?.duration_ms ?? 0)) < 50));
    const http = events.filter((event) => event.name === 'POST /v1/messages' && event['http.status'] === 429);
    return [
      { label: 'failed model calls retried within milliseconds of each other, no backoff', ev: ids(quick) },
      { label: 'every attempt resent the whole order context: identical request body sizes on the first HTTP attempt of each failed call', ev: ids(http.filter((event) => attribute(event, 'retry.attempt') === 1)) },
      { label: 'two retry layers multiply: the SDK made second and third HTTP attempts beneath each harness attempt', ev: ids(http.filter((event) => Number(attribute(event, 'retry.attempt')) > 1)) },
    ];
  },
  '05-the-altered-figure': (events, blobs) => {
    const after = tool(events, 'get_invoices').filter((event) => attribute(event, 'mcp.server.version') === '2.9.0' && !event['error.type']);
    const sessions = new Set(after.map((event) => event.trace_id));
    const httpAfter = events.filter((event) => event.name === 'POST /mcp' && after.some((parent) => parent.span_id === event.parent_span_id));
    const hundredfold = /£\s?\d{1,3}(,\d{3})+(\.00)?\b|pence/i;
    return [
      { label: 'after the release, get_invoices returned whole numbers a hundred times the pounds-and-pence amounts it returned before', ev: ids(after) },
      { label: 'the raw server payloads after the release: version 2.9.0, schema_version still "2", amount still named amount', ev: ids(httpAfter) },
      {
        label: 'the model worked faithfully from what it was given: it quoted the hundredfold figure, or said the amounts looked like pence',
        ev: ids(chats(events).filter((event) => sessions.has(event.trace_id) && hundredfold.test(fullText(event, blobs)))),
      },
    ];
  },
  '06-the-marked-paper': (events) => [
    { label: 'eval traces with no http.server span beneath the eval root', ev: ids(events.filter((e) => e.name.startsWith('eval '))) },
    { label: 'production requests stopped with a 413 at the adapter', ev: ids(events.filter((e) => e['span.kind'] === 'server' && e['http.status'] === 413)) },
    {
      label: 'eval requests carried an x-eval-user header that no production request carries',
      ev: ids(events.filter((e) => e['gen_ai.operation.name'] === 'invoke_agent' && headerNames(e).includes('x-eval-user'))),
    },
  ],
  '07-the-wrong-door': (events) => {
    const routes = events.filter((event) => event.name === 'route request');
    return [
      { label: 'the router recorded its rule as input length under 280 characters and sent short trade questions to the small route', ev: ids(routes.filter((event) => attribute(event, 'task.tier') === 'specialist')) },
      {
        label: 'every trade question answered on the small route, which has no cask or bond tools, was turned away',
        ev: ids(events.filter((event) => event['gen_ai.operation.name'] === 'invoke_agent' && attribute(event, 'task.tier') === 'specialist' && attribute(event, 'router.route') === 'small')),
      },
      { label: 'long, simple visitor questions went to the large model', ev: ids(routes.filter((event) => attribute(event, 'task.tier') === 'routine' && attribute(event, 'router.route') === 'large')) },
    ];
  },
  '08-the-lapsed-policy': (events) => [
    {
      label: 'cache hits after 1 August that served answers written under the old terms',
      ev: ids(events.filter((event) => event.name === 'cache lookup' && attribute(event, 'cache.hit') === true && attribute(event, 'cache.entry_policy_version') !== attribute(event, 'policy.version'))),
    },
    { label: 'on cache misses the document search returned the new 24-hour terms', ev: ids(tool(events, 'search_documents').filter((event) => attribute(event, 'document.version') === 'terms-2026-08')) },
    { label: 'the cache key is the question alone: no policy version in it', ev: ids(events.filter((event) => event.name === 'cache store')) },
  ],
  '09-the-empty-cabinet': (events) => {
    const listings = tool(events, 'list_folder');
    const outOfScope = (event: TraceEvent) => {
      const path = String(attribute(event, 'connector.path') ?? '');
      const roots = String(attribute(event, 'connector.allowed_roots') ?? '').split(';');
      return !roots.some((root) => path === root || path.startsWith(`${root}/`));
    };
    const silent = listings.filter((event) => !event['error.type'] && /"files":\[\]/.test(event.preview ?? '') && outOfScope(event));
    const sessions = new Set(silent.map((event) => event.trace_id));
    return [
      { label: 'list_folder returned an empty list with no error for a job folder outside the connector scope', ev: ids(silent) },
      { label: "the branch machines' connectors were granted Documents only, not the shared jobs drive", ev: ids(events.filter((event) => event['gen_ai.operation.name'] === 'invoke_agent' && sessions.has(event.trace_id))) },
      { label: 'the same job folders listed their files on a pilot machine with the shared drive in scope', ev: ids(listings.filter((event) => String(attribute(event, 'connector.path') ?? '').startsWith('S:/Jobs/') && /"files":\["/.test(event.preview ?? ''))) },
    ];
  },
  '10-the-willing-hand': (events) => {
    const approvals = events.filter((event) => event.name === 'approval review');
    const floor = (event: TraceEvent) => 5_000 + Number(attribute(event, 'approval.diff_lines') ?? 1) * 200;
    return [
      { label: 'approvals in 400 ms, under the reading floor for the diff, with clarifying questions dismissed', ev: ids(approvals.filter((event) => Number(attribute(event, 'approval.latency_ms')) < floor(event))) },
      { label: 'on Monday and on Thursday morning the same reviewer took 20 to 40 seconds per approval', ev: ids(approvals.filter((event) => Number(attribute(event, 'approval.latency_ms')) >= floor(event))) },
      { label: 'the agent asked clarifying questions, and they were dismissed unanswered', ev: ids(tool(events, 'ask_question').filter((event) => /dismissed/.test(event.preview ?? ''))) },
    ];
  },
};
