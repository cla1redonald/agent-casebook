import type { TraceEvent } from '../../src/trace/schema.js';
import { byTraceId } from '../../src/trace/read.js';
import type { DetectorMeta, Finding } from '../types.js';

export const meta: DetectorMeta = {
  id: 'd06',
  slug: 'path-parity',
  title: 'Eval path parity',
  case: '06-the-marked-paper',
  status: 'implemented',
  rule:
    'Every eval trace must contain the same HTTP adapter span that production traffic passes through, and must not send request headers that production never sends.',
  blindSpots: [
    'Eval traces must carry `deployment.environment.name` (eval, evaluation, test or ci); unlabelled evals are invisible.',
    'An eval that goes through a differently configured adapter (say, a staging body limit) still has the span and passes.',
    'A mock adapter that emits a server span passes; the check is on structure, not on configuration.',
    'Header parity needs production traces in the same sweep; with evals alone only the missing-span rule runs.',
  ],
};

const EVAL_ENVIRONMENTS = new Set(['eval', 'evaluation', 'test', 'ci']);

function environmentOf(session: readonly TraceEvent[]): string | undefined {
  return session.find((event) => event['deployment.environment.name'] !== undefined)?.['deployment.environment.name'];
}

function headerNames(event: TraceEvent): string[] {
  const names: string[] = [];
  for (const [key, value] of Object.entries(event.attributes ?? {})) {
    if (key.endsWith('header_names') && Array.isArray(value)) names.push(...value);
  }
  return names;
}

function isAdapterSpan(event: TraceEvent): boolean {
  return event['span.kind'] === 'server' && event['http.route'] !== undefined;
}

/** Detects eval traces that skipped the production request path. */
export function detect(events: readonly TraceEvent[]): Finding[] {
  const sessions = [...byTraceId(events).values()];
  const evals = sessions.filter((session) => EVAL_ENVIRONMENTS.has(environmentOf(session) ?? ''));
  if (evals.length === 0) return [];
  const production = sessions.filter((session) => environmentOf(session) === 'production');

  const productionHeaders = new Set(production.flatMap((session) => session.flatMap(headerNames)));
  const rejected = production.flatMap((session) => session.filter((event) => isAdapterSpan(event) && (event['http.status'] ?? 0) >= 400));
  const rejectedNote =
    rejected.length > 0
      ? ` Meanwhile the adapter rejected ${rejected.length} production request(s) (${[...new Set(rejected.map((event) => event['http.status']))].join(', ')}), a path this eval never exercised.`
      : '';

  const findings: Finding[] = [];
  for (const session of evals) {
    const root = session[0];
    if (!root) continue;
    const missingAdapter = !session.some(isAdapterSpan);
    const carriers = production.length > 0 ? session.filter((event) => headerNames(event).some((name) => !productionHeaders.has(name))) : [];
    const strayHeaders = [...new Set(carriers.flatMap(headerNames).filter((name) => !productionHeaders.has(name)))];
    if (!missingAdapter && strayHeaders.length === 0) continue;

    const parts: string[] = [];
    if (missingAdapter) parts.push('Eval trace has no HTTP adapter span: it reached the application without passing the production request path.');
    if (strayHeaders.length > 0) parts.push(`It sent header(s) no production request sent: ${strayHeaders.join(', ')}.`);
    findings.push({
      detector: meta.id,
      severity: missingAdapter ? 'high' : 'medium',
      message: parts.join(' ') + (missingAdapter ? rejectedNote : ''),
      ev: [root.ev, ...carriers.map((event) => event.ev).filter((ev) => ev !== root.ev)],
      trace_ids: [root.trace_id],
    });
  }
  return findings;
}
