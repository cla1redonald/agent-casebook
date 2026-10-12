import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { readTrace } from '../../src/trace/read.js';
import { repoRoot } from '../../src/util/root.js';
import { event, resetEvents } from '../../test/helpers.js';
import { detect, meta } from './d05-unit-drift.js';

const root = repoRoot();
const caseDir = join(root, 'cases', meta.case);

describe('d05 unit drift on the live recordings', () => {
  it('fires on trace.jsonl', () => {
    const findings = detect(readTrace(join(caseDir, 'trace.jsonl')).events);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]?.message).toMatch(/jumped about \d+ times .* same schema version \(2\)/);
  });

  it('is silent on sealed/trace.fixed.jsonl', () => {
    expect(detect(readTrace(join(caseDir, 'sealed', 'trace.fixed.jsonl')).events)).toEqual([]);
  });

  it('is silent on every control trace', () => {
    const dir = join(root, 'corpus', 'control');
    for (const name of readdirSync(dir).filter((file) => file.endsWith('.jsonl'))) {
      expect({ name, findings: detect(readTrace(join(dir, name)).events) }).toEqual({ name, findings: [] });
    }
  });
});

describe('d05 rules', () => {
  beforeEach(resetEvents);

  const tool = (amounts: number[], version = '2.8.1') =>
    event({
      name: 'execute_tool get_invoices',
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'get_invoices',
      preview: JSON.stringify({ lines: amounts.map((amount) => ({ amount, schema_version: '2' })) }),
      attributes: { 'mcp.server.version': version },
    });

  it('reports a hundredfold jump under the same schema version, and the lost decimals', () => {
    const findings = detect([tool([412.65, 99.1]), tool([250.5]), tool([88.2, 310.75]), tool([41265, 9910], '2.9.0')]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/same schema version \(2\)/);
    expect(findings[0]?.message).toMatch(/lost their decimal places/);
    expect(findings[0]?.message).toMatch(/2\.8\.1 to 2\.9\.0/);
  });

  it('reports decimals turning into whole numbers ten times larger or more', () => {
    expect(detect([tool([412.65]), tool([99.1]), tool([250.5]), tool([8292])])[0]?.message).toMatch(/lost their decimal places/);
  });

  it('ignores ordinary variation, and tenfold jumps in whole-number fields', () => {
    expect(detect([tool([400]), tool([380]), tool([410]), tool([4100]), tool([395])])).toEqual([]);
  });

  it('needs three earlier samples', () => {
    expect(detect([tool([4.1]), tool([410])])).toEqual([]);
  });
});
