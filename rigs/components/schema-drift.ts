import { z } from 'zod';
import type { FaultPlan } from '../faults.js';

/** What the accounts server returns for one invoice line. */
export type InvoiceLine = { reference: string; amount: number; schema_version: string } | { reference: string; amount_pence: number; schema_version: string };

/** The schema the client was written against: amount in pounds, as a decimal. */
export const invoiceLineV2 = z.object({ reference: z.string(), amount: z.number(), schema_version: z.literal('2') }).strict();

/**
 * Simulates an accounts server before and after a release.
 * Before the release: amount is pounds as a float.
 * Correct release: the unit change comes with a new field name and version, so old clients fail loudly.
 * Fault schema_field_rename: amount silently becomes integer pence under the same name and version.
 */
export function invoiceLine(reference: string, pounds: number, options: { released: boolean; faults: FaultPlan; atMs: number }): InvoiceLine {
  if (!options.released) return { reference, amount: pounds, schema_version: '2' };
  const pence = Math.round(pounds * 100);
  if (options.faults.active('schema_field_rename', options.atMs)) return { reference, amount: pence, schema_version: '2' };
  return { reference, amount_pence: pence, schema_version: '3' };
}
