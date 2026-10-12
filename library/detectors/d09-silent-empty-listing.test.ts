import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { readTrace } from '../../src/trace/read.js';
import { repoRoot } from '../../src/util/root.js';
import { event, resetEvents } from '../../test/helpers.js';
import { detect, meta } from './d09-silent-empty-listing.js';

const root = repoRoot();
const caseDir = join(root, 'cases', meta.case);

describe('d09 silent empty listing on the live recordings', () => {
  it('fires on trace.jsonl', () => {
    const findings = detect(readTrace(join(caseDir, 'trace.jsonl')).events);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]?.message).toMatch(/outside the connector.s granted roots/);
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

describe('d09 rules', () => {
  beforeEach(resetEvents);

  const listing = (path: string, files: string[], extra: Record<string, unknown> = {}) =>
    event({
      name: 'execute_tool list_folder',
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'list_folder',
      preview: JSON.stringify({ folder: path, files }),
      attributes: { 'connector.path': path, 'connector.allowed_roots': 'H:/Staff/a/Documents' },
      ...extra,
    });

  it('reports an empty listing outside the granted roots', () => {
    expect(detect([listing('S:/Jobs/2024/HS-2024-0187', [])])).toHaveLength(1);
  });

  it('reports an empty listing of a path that listed files elsewhere', () => {
    const elsewhere = listing('H:/Staff/a/Documents/Old', ['a.pdf']);
    expect(detect([elsewhere, listing('H:/Staff/a/Documents/Old', [])])[0]?.message).toMatch(/listed files elsewhere/);
  });

  it('stays silent on an empty folder in scope, and on a permission error', () => {
    expect(detect([listing('H:/Staff/a/Documents/New', []), listing('S:/Jobs', [], { 'error.type': 'permission_denied', preview: 'No permission' })])).toEqual([]);
  });
});
