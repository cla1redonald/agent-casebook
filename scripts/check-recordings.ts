/**
 * Scans every recorded trace, cassette and locker blob before it is committed:
 *
 * - credentials: Anthropic key shapes, bearer tokens, and the live key itself when it is set;
 * - personal data: email addresses outside example.scot and example.invalid, and telephone
 *   numbers outside the Ofcom ranges reserved for drama;
 * - the project deny list and the em dash (from DENY_LIST or .denylist, as check-terms does);
 * - labels: every live trace's header names the model, the date, the rig version and says it
 *   is a live recording, and no live chat span claims to be a stub (and the reverse);
 * - the locker: every blob a trace references exists and hashes to its id.
 *
 * Prints file names, line numbers and rule names only, never the matched text.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTrace } from '../src/trace/read.js';
import { EM_DASH, loadTerms, scanText } from './check-terms.js';

const ALLOWED_EMAIL_DOMAINS = /(^|\.)example\.(scot|invalid)$/i;
/** Ofcom's drama ranges: 01632 960000 to 960999, 07700 900000 to 900999, 020 7946 0000 to 0999. */
const DRAMA_NUMBERS = [/^01632960\d{3}$/, /^07700900\d{3}$/, /^02079460\d{3}$/];

export interface Finding {
  file: string;
  line: number;
  rule: string;
}

export function scanContent(file: string, text: string, secret?: string): Finding[] {
  const findings: Finding[] = [];
  text.split('\n').forEach((line, index) => {
    const at = (rule: string) => findings.push({ file, line: index + 1, rule });
    if (/sk-ant-[A-Za-z0-9_-]{8,}/.test(line)) at('anthropic key shape');
    if (/Bearer\s+[A-Za-z0-9._~+/-]{16,}/.test(line)) at('bearer token value');
    if (secret && secret.length >= 8 && line.includes(secret)) at('the live API key');
    for (const match of line.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g)) {
      if (!ALLOWED_EMAIL_DOMAINS.test(match[1] ?? '')) at('email outside example.scot and example.invalid');
    }
    for (const match of line.matchAll(/(?<![0-9A-Za-z.])(?:\+44\s?|0)\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,4}(?![0-9A-Za-z.])/g)) {
      const digits = match[0].replace(/\D/g, '').replace(/^44/, '0');
      if (digits.length >= 10 && digits.length <= 11 && !DRAMA_NUMBERS.some((range) => range.test(digits))) at('telephone number outside the drama ranges');
    }
  });
  return findings;
}

/** Checks a trace's labels and its locker references. */
export function checkTrace(file: string, text: string, lockerDir: string | null): Finding[] {
  const findings: Finding[] = [];
  const at = (rule: string, line = 1) => findings.push({ file, line, rule });
  const trace = parseTrace(text, file);
  const header = trace.header;
  if (!header) return [{ file, line: 1, rule: 'no header line' }];
  const chats = trace.events.filter((event) => event['gen_ai.operation.name'] === 'chat' && event['gen_ai.response.model']);
  if (header.recording === 'live') {
    if (!/^claude-[a-z0-9-]+$/.test(header.model)) at('live header does not name a model id');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(header.recorded_on)) at('live header has no recording date');
    if (!header.rig_version) at('live header has no rig version');
    if (!header.note.startsWith('LIVE RECORDING.')) at('live header note does not say LIVE RECORDING');
    if (header.clock === 'simulated') at('live header claims a simulated clock');
    if (chats.some((event) => (event['gen_ai.response.model'] ?? '').startsWith('stub/'))) at('live trace contains a stub response');
  } else {
    if (!header.note.startsWith('STUB RECORDING.')) at('stub header note does not say STUB RECORDING');
    if (chats.some((event) => !(event['gen_ai.response.model'] ?? '').startsWith('stub/'))) at('stub trace contains a response not labelled stub');
  }
  if (lockerDir) {
    for (const event of trace.events) {
      if (!event.locker) continue;
      const hash = event.locker.slice('sha256:'.length);
      const blob = join(lockerDir, `${hash}.json`);
      if (!existsSync(blob)) {
        at(`locker blob missing for ${event.ev}`);
        continue;
      }
      const stored = readFileSync(blob, 'utf8').replace(/\n$/, '');
      const candidates = [stored];
      try {
        candidates.push(JSON.stringify(JSON.parse(stored)));
      } catch {
        // Stored as text.
      }
      if (!candidates.some((candidate) => createHash('sha256').update(candidate).digest('hex') === hash)) at(`locker blob for ${event.ev} does not hash to its id`);
    }
  }
  return findings;
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

function main(): void {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const { terms, origin } = loadTerms(process.env, root);
  if (terms.length === 0) {
    console.error('recordings check: the deny list is empty. Set DENY_LIST (CI secret) or create .denylist in the repo root.');
    process.exit(1);
  }
  const files = ['cases', 'corpus', 'recordings'].flatMap((dir) => walk(join(root, dir))).filter((path) => /\.(jsonl|json)$/.test(path));
  const findings: Finding[] = [];
  let traces = 0;
  for (const path of files) {
    const file = relative(root, path);
    const text = readFileSync(path, 'utf8');
    findings.push(...scanContent(file, text, process.env['ANTHROPIC_API_KEY']));
    for (const hit of scanText(file, text, [...terms, EM_DASH])) findings.push({ file, line: hit.line, rule: `deny list term #${hit.termIndex + 1}` });
    const isTrace = path.endsWith('.jsonl') && !path.endsWith('.cassette.jsonl') && !path.endsWith('spend.jsonl');
    if (isTrace) {
      traces += 1;
      const lockerDir = [join(dirname(path), 'locker'), join(dirname(path), '..', 'locker')].find((dir) => existsSync(dir)) ?? null;
      findings.push(...checkTrace(file, text, lockerDir));
    }
  }
  if (findings.length > 0) {
    console.error(`recordings check: ${findings.length} finding(s)`);
    for (const finding of findings.slice(0, 200)) console.error(`  ${finding.file}:${finding.line}: ${finding.rule}`);
    process.exit(1);
  }
  console.log(`recordings check: clean (${files.length} files, ${traces} traces; ${terms.length} terms from ${origin}, plus em dash, keys, emails, telephone numbers, labels and locker hashes)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
