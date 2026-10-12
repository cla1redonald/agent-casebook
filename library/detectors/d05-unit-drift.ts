import type { TraceEvent } from '../../src/trace/schema.js';
import { median } from '../stats.js';
import type { DetectorMeta, Finding } from '../types.js';

export const meta: DetectorMeta = {
  id: 'd05',
  slug: 'unit-drift',
  title: 'Unit drift',
  case: '05-the-altered-figure',
  status: 'implemented',
  rule:
    'A numeric tool output field whose typical magnitude jumps by a factor of about 100 (between 50 and 200) against its own history, or that always carried decimal places and now carries whole numbers ten or more times larger, suggests a unit change under the same name.',
  blindSpots: [
    'Fields that change unit by a factor other than about 100 need their own ratio.',
    'Low-volume fields with fewer than three samples before the change are not judged.',
    'Values are read from the span preview (the first 220 characters of the output); a field that only appears further in is not seen.',
    'A genuine hundredfold change in the data itself (a much larger order) looks the same.',
    'The decimals-to-whole-numbers rule was added after the live recording of case 5 showed a small invoice whose jump was only 15 times the field median across all suppliers; it has not been tested on traffic it was not written for.',
  ],
};

const NUMBER_FIELD = /"([A-Za-z_][\w]*)"\s*:\s*(-?\d+(?:\.\d+)?)(?=[,}\]])/g;
const SCHEMA = /"schema_version"\s*:\s*"?([\w.-]+)"?/;
const WINDOW = 20;

interface Series {
  values: number[];
  schema: string | undefined;
  serverVersion: string | undefined;
  decimals: boolean;
}

/** Detects numeric fields that silently changed unit, judged against each field's own history. */
export function detect(events: readonly TraceEvent[]): Finding[] {
  const series = new Map<string, Series>();
  const findings: Finding[] = [];
  for (const event of events) {
    if (event['gen_ai.operation.name'] !== 'execute_tool' || event['error.type'] !== undefined || !event.preview) continue;
    const tool = event['gen_ai.tool.name'] ?? event.name;
    const schema = SCHEMA.exec(event.preview)?.[1];
    const serverVersion = typeof event.attributes?.['mcp.server.version'] === 'string' ? String(event.attributes['mcp.server.version']) : undefined;
    const byField = new Map<string, number[]>();
    for (const match of event.preview.matchAll(NUMBER_FIELD)) {
      const [, field, raw] = match;
      if (!field || !raw) continue;
      byField.set(field, [...(byField.get(field) ?? []), Number(raw)]);
    }
    const drifted: string[] = [];
    for (const [field, values] of byField) {
      const key = `${tool}|${field}`;
      const history = series.get(key);
      const now = median(values.map(Math.abs));
      if (history && history.values.length >= 3) {
        const before = median(history.values.map(Math.abs));
        const ratio = before >= 1 ? now / before : 0;
        const lostDecimals = history.decimals && values.every(Number.isInteger) && history.values.every((value) => !Number.isInteger(value));
        if ((ratio >= 50 && ratio <= 200) || (lostDecimals && ratio >= 10)) {
          const sameSchema = history.schema === schema;
          const notes = [
            `${tool}.${field} jumped about ${Math.round(ratio)} times (median ${before} before, ${now} now)`,
            sameSchema ? `with the same schema version (${schema ?? 'none recorded'})` : `while the schema version changed from ${history.schema} to ${schema}`,
          ];
          if (lostDecimals) notes.push('and the values lost their decimal places');
          if (serverVersion && history.serverVersion && serverVersion !== history.serverVersion) notes.push(`after the server moved from ${history.serverVersion} to ${serverVersion}`);
          drifted.push(`${notes.join(' ')}.`);
          // Drifted values are not added to the history, so every later call is judged against the old unit.
          continue;
        }
      }
      const next: Series = history ?? { values: [], schema, serverVersion, decimals: false };
      next.values = [...next.values, ...values].slice(-WINDOW);
      next.schema = schema;
      next.serverVersion = serverVersion;
      next.decimals = next.decimals || values.some((value) => !Number.isInteger(value));
      series.set(key, next);
    }
    if (drifted.length > 0) findings.push({ detector: meta.id, severity: 'high', message: drifted.join(' '), ev: [event.ev], trace_ids: [event.trace_id] });
  }
  return findings;
}
