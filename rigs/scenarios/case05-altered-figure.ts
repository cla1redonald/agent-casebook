/**
 * Case 5, The Altered Figure. Kinbrae Bakeries finance.
 *
 * The finance officer's assistant reads supplier invoices through the accounts supplier's MCP
 * server and drafts the weekly payment run. On Friday 2 October at 18:00 a new server version
 * goes out. In the incident variant the release changes `amount` from pounds to pence under the
 * same field name and the same schema version, so every figure is a hundred times too large and
 * the model adds them up faithfully. In the fixed variant the release renames the field and bumps
 * the schema version, and the assistant's client, which validates against the schema it was built
 * for, refuses the payload loudly.
 */
import { z } from 'zod';
import type { AgentConfig } from '../agent.js';
import { invoiceLine, invoiceLineV2 } from '../components/schema-drift.js';
import { httpCall } from '../components/upstream.js';
import { FaultPlan } from '../faults.js';
import { addDays, bst, longDate, makeEnv, type Recording, type RecordingMode } from '../scenario.js';
import { defineTool, type Tool } from '../tools.js';
import { ask, fnv, pounds, workingDays } from './common.js';

export const CASE_ID = '05-the-altered-figure';
const EPOCH = '2026-09-20T23:00:00Z';
const START_DATE = '2026-09-21';
const DAYS = 19;
const RELEASE_MS = bst('2026-10-02', '18:00');
const SERVER = 'https://mcp.kinbrae-accounts.example.scot/mcp';

const SUPPLIERS = ['Strathmore Flour Mill', 'Glenbervie Dairy', 'Fife Box and Carton', 'Tayside Eggs', 'Kingdom Butchers'] as const;
type Supplier = (typeof SUPPLIERS)[number];
const CODES: Record<Supplier, string> = { 'Strathmore Flour Mill': 'SFM', 'Glenbervie Dairy': 'GBD', 'Fife Box and Carton': 'FBC', 'Tayside Eggs': 'TYE', 'Kingdom Butchers': 'KGB' };

/** The Monday of the week containing an ISO date. */
function mondayOf(isoDate: string): string {
  const date = new Date(`${isoDate}T12:00:00Z`);
  const back = (date.getUTCDay() + 6) % 7;
  return addDays(isoDate, -back);
}

interface Invoice {
  reference: string;
  supplier: Supplier;
  pounds: number;
}

/** The week's invoices. The flour mill's invoice INV-SFM-2291 for £412.65 is the one the finance officer checked. */
export function invoicesFor(week: string): Invoice[] {
  const out: Invoice[] = [];
  for (const supplier of SUPPLIERS) {
    const count = 1 + (fnv(`${supplier}|${week}|n`) % 2);
    for (let index = 0; index < count; index++) {
      const seed = `${supplier}|${week}|${index}`;
      const fixed = week === '2026-10-05' && supplier === 'Strathmore Flour Mill' && index === 0;
      out.push({
        reference: fixed ? 'INV-SFM-2291' : `INV-${CODES[supplier]}-${1000 + (fnv(seed) % 8999)}`,
        supplier,
        pounds: fixed ? 412.65 : pounds(seed, 64, 940),
      });
    }
  }
  return out;
}

interface Options {
  variant: 'incident' | 'fixed';
  mode?: RecordingMode;
}

function tools(touched: Set<string>): Tool[] {
  const getInvoices = defineTool({
    name: 'get_invoices',
    description:
      'Supplier invoices from the accounts system for one week, through the accounts MCP server. Each line has a reference, the supplier and `amount`, the invoice total in pounds (GBP) as a decimal.',
    input: z.object({ supplier: z.enum([...SUPPLIERS, 'all']), week_commencing: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict(),
    execute: async (input, context) => {
      const week = mondayOf(input.week_commencing);
      const released = context.clock.now() >= RELEASE_MS;
      const lines = invoicesFor(week)
        .filter((invoice) => input.supplier === 'all' || invoice.supplier === input.supplier)
        .map((invoice) => {
          const line = invoiceLine(invoice.reference, invoice.pounds, { released, faults: context.faults, atMs: context.clock.now() });
          return { ...line, supplier: invoice.supplier };
        });
      const version = released ? '2.9.0' : '2.8.1';
      const reply = await httpCall(context, 'POST', SERVER, (atMs) => ({
        status: 200,
        body: JSON.stringify({ lines, week_commencing: week, currency: 'GBP' }),
        latencyMs: 210 + (fnv(String(atMs)) % 90),
      }));
      const attributes = { 'mcp.server.name': 'kinbrae-accounts', 'mcp.server.version': version, 'mcp.tool.name': 'list_invoices', 'invoice.lines': lines.length };
      // The client was built for schema version 2 and checks every line against it.
      const parsed = z.object({ lines: z.array(invoiceLineV2.extend({ supplier: z.string() }).strict()) }).passthrough().safeParse(JSON.parse(reply.body));
      if (!parsed.success) {
        return {
          content: `The accounts server (version ${version}) returned invoice lines this assistant was not built for: expected schema version 2 with "amount" in pounds. Not guessing the unit; no figures returned.`,
          isError: true,
          errorType: 'schema_mismatch',
          source: 'accounts-mcp',
          attributes,
        };
      }
      if (released && context.faults.active('schema_field_rename', context.clock.now())) touched.add(context.traceId);
      return { content: reply.body, source: 'accounts-mcp', attributes };
    },
  });
  const draftRun = defineTool({
    name: 'draft_payment_run',
    description: 'Drafts the supplier payment run for a week, one total per supplier in pounds. The draft waits for the finance officer to approve it.',
    input: z
      .object({
        week_commencing: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        lines: z.array(z.object({ supplier: z.string(), total_gbp: z.number() }).strict()),
      })
      .strict(),
    execute: async (input, context) => {
      context.clock.advance(40);
      const total = Math.round(input.lines.reduce((sum, line) => sum + line.total_gbp, 0) * 100) / 100;
      const run = `PR-${mondayOf(input.week_commencing)}`;
      return {
        content: JSON.stringify({ run, status: 'draft, awaiting approval by the finance officer', total_gbp: total, lines: input.lines.length }),
        source: 'payments',
        attributes: { 'payment_run.total_gbp': total, 'payment_run.lines': input.lines.length },
      };
    },
  });
  return [getInvoices, draftRun];
}

const SYSTEM =
  "You prepare Kinbrae Bakeries' supplier payments for the finance officer. Use get_invoices for every amount and never estimate one. " +
  'Draft payment runs with draft_payment_run; they wait for her approval. Give totals to the penny and keep answers short.';

interface Session {
  at: number;
  question: string;
}

function schedule(): Session[] {
  const sessions: Session[] = [];
  for (const date of workingDays(START_DATE, DAYS)) {
    const monday = mondayOf(date);
    const week = `the week commencing ${longDate(monday)}`;
    if (date === monday) {
      sessions.push({ at: bst(date, '09:30'), question: `Prepare the supplier payment run for ${week}: total each supplier's invoices and draft the run.` });
    }
    const supplier = SUPPLIERS[fnv(`${date}|q`) % SUPPLIERS.length] ?? 'Glenbervie Dairy';
    const kind = fnv(`${date}|k`) % 3;
    const question =
      kind === 0 ? `How much do we owe ${supplier} for ${week}?`
      : kind === 1 ? `Which is the largest single supplier invoice for ${week}, and how much is it?`
      : `What is the total of all supplier invoices for ${week}?`;
    sessions.push({ at: bst(date, date === monday ? '14:10' : '11:20'), question });
  }
  return sessions;
}

export async function recordCase05(variant: 'incident' | 'fixed', mode: RecordingMode = { kind: 'stub' }): Promise<Recording> {
  return recordAlteredFigure({ variant, mode });
}

async function recordAlteredFigure(options: Options): Promise<Recording> {
  const faults = options.variant === 'incident' ? new FaultPlan([{ name: 'schema_field_rename' }]) : FaultPlan.none();
  const env = makeEnv(EPOCH, 5_005, faults, options.mode);
  const touched = new Set<string>();
  const config: AgentConfig = {
    name: 'payments-assistant',
    model: env.model,
    system: SYSTEM,
    tools: tools(touched),
    maxTurns: 8,
    maxTokens: 1024,
    client: env.client,
    clock: env.clock,
    trace: env.trace,
    faults: env.faults,
  };
  for (const session of schedule()) {
    env.clock.set(Math.max(session.at, env.clock.now()));
    await ask(env, config, {
      identity: { subject: 'finance-officer', role: 'finance', tenant: 'kinbrae-bakeries' },
      question: session.question,
      fields: { 'deployment.environment.name': 'production', attributes: { 'session.channel': 'desktop' } },
    });
  }
  return {
    header: env.header({
      caseId: CASE_ID,
      variant: options.variant,
      epochIso: EPOCH,
      redactions: [{ field: 'staff identity', method: 'replaced with role names' }],
    }),
    events: env.trace.events(),
    blobs: env.trace.blobs,
    faultedTraceIds: [...touched],
  };
}
