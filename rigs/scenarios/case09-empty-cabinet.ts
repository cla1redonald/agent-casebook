/**
 * Case 9, The Empty Cabinet. Hepburn Strachan Chartered Surveyors.
 *
 * A desktop assistant with a file connector is piloted on two main-office machines, whose
 * connectors were granted the user's Documents folder and, by hand, the shared jobs drive. The
 * rollout checklist written after the pilot grants Documents only. In the incident variant a
 * folder outside the granted roots lists as empty with no error; in the fixed variant it returns
 * a permission error the assistant can relay. The cloud sync service has a two-hour outage in the
 * rollout's first week, which is recorded and is not the cause.
 */
import { z } from 'zod';
import type { AgentConfig } from '../agent.js';
import { listFolder } from '../components/connector.js';
import { FaultPlan } from '../faults.js';
import { bst, makeEnv, type Recording, type RecordingMode } from '../scenario.js';
import { defineTool, type Tool } from '../tools.js';
import { ask, fnv, workingDays } from './common.js';

export const CASE_ID = '09-the-empty-cabinet';
const EPOCH = '2026-09-06T23:00:00Z';
const PILOT_START = '2026-09-07';
const ROLLOUT_START = '2026-09-14';
const OUTAGE = { from: bst('2026-09-15', '10:00'), until: bst('2026-09-15', '12:05') };
const SHARED = 'S:/Jobs';

interface Machine {
  name: string;
  office: 'main' | 'branch';
  user: string;
  pilot: boolean;
}
const MACHINES: Machine[] = [
  { name: 'HS-MAIN-PILOT-01', office: 'main', user: 'admin-main-1', pilot: true },
  { name: 'HS-MAIN-PILOT-02', office: 'main', user: 'admin-main-2', pilot: true },
  { name: 'HS-BRANCH-03', office: 'branch', user: 'admin-branch-1', pilot: false },
  { name: 'HS-BRANCH-04', office: 'branch', user: 'admin-branch-2', pilot: false },
  { name: 'HS-BRANCH-05', office: 'branch', user: 'admin-branch-3', pilot: false },
];

function documents(machine: Machine): string {
  return `H:/Staff/${machine.user}/Documents`;
}

/** The pilot machines were given the shared drive by hand; the rollout checklist missed that step. */
function grantedRoots(machine: Machine): string[] {
  return machine.pilot ? [documents(machine), SHARED] : [documents(machine)];
}

interface Job {
  job: string;
  year: number;
  address: string;
}
const JOBS: Job[] = [
  { job: 'HS-2024-0187', year: 2024, address: '7 Craigend Road, Dunmore' },
  { job: 'HS-2025-0342', year: 2025, address: '22 Brae Street, Kinross' },
  { job: 'HS-2026-0415', year: 2026, address: '3 Mill Lade, Auchterarder' },
  { job: 'HS-2026-0433', year: 2026, address: '14 Kirkgate, Dunmore' },
  { job: 'HS-2023-0098', year: 2023, address: 'Easter Bankhead Farmhouse, Glendevon' },
];

function jobFolder(job: Job): string {
  return `${SHARED}/${job.year}/${job.job}`;
}

function filesIn(folder: string): string[] {
  const job = JOBS.find((candidate) => jobFolder(candidate) === folder);
  if (job) return [`${job.job} Survey Report.pdf`, `${job.job} Instruction Letter.pdf`, `${job.job} Site Notes.docx`, 'photos.zip'];
  if (folder.endsWith('/Documents')) return ['Rota September.xlsx', 'Client letter template.docx', 'Fee quotes 2026.xlsx'];
  if (folder.endsWith('/Documents/Templates')) return ['Condition report template.docx', 'Valuation instruction template.docx'];
  return [];
}

function tools(machine: Machine, sink: { emptyOutOfScope: boolean }): Tool[] {
  return [
    defineTool({
      name: 'list_folder',
      description: 'Lists the files in a folder through the desktop file connector. Paths look like S:/Jobs/2025/HS-2025-0342 or H:/Staff/<name>/Documents (the home drive).',
      input: z.object({ path: z.string() }).strict(),
      execute: async (input, context) => {
        context.clock.advance(35 + (fnv(input.path) % 30));
        const path = input.path.replace(/\\/g, '/').replace(/\/+$/, '');
        const roots = grantedRoots(machine);
        const outcome = listFolder({ folder: path, grantedFolders: roots, files: filesIn(path) }, { faults: context.faults, atMs: context.clock.now() });
        const inScope = roots.some((root) => path === root || path.startsWith(`${root}/`));
        if (!inScope && !outcome.isError) sink.emptyOutOfScope = true;
        return { ...outcome, attributes: { 'connector.path': path, 'connector.allowed_roots': roots.join(';'), 'device.name': machine.name } };
      },
    }),
    defineTool({
      name: 'read_file',
      description: 'Reads the first page of a document through the desktop file connector.',
      input: z.object({ path: z.string() }).strict(),
      execute: async (input, context) => {
        context.clock.advance(120);
        const path = input.path.replace(/\\/g, '/');
        const roots = grantedRoots(machine);
        if (!roots.some((root) => path.startsWith(`${root}/`))) {
          return { content: `No permission to read ${path}.`, isError: true, errorType: 'permission_denied', source: 'connector', attributes: { 'connector.path': path, 'connector.allowed_roots': roots.join(';') } };
        }
        const job = JOBS.find((candidate) => path.startsWith(jobFolder(candidate)));
        const text = job ? `Hepburn Strachan condition survey, job ${job.job}, ${job.address}. Inspected ${job.year}. Roof, walls, damp, services and garden reported section by section.` : 'Document text.';
        return { content: text, source: 'connector', attributes: { 'connector.path': path, 'connector.allowed_roots': roots.join(';') } };
      },
    }),
  ];
}

const SYSTEM =
  'You are the desktop assistant for office administrators at Hepburn Strachan Chartered Surveyors. Job folders are on the shared drive at S:/Jobs/<year>/<job number>. ' +
  "Use list_folder and read_file to find documents, and tell the user plainly what you found. Each user's own files are in H:/Staff/<name>/Documents.";

interface Session {
  at: number;
  machine: Machine;
  question: string;
}

function schedule(): Session[] {
  const sessions: Session[] = [];
  const days = [...workingDays(PILOT_START, 5), ...workingDays(ROLLOUT_START, 12)];
  for (const date of days) {
    const pilotWeek = date < ROLLOUT_START;
    const active = pilotWeek ? MACHINES.filter((machine) => machine.pilot) : MACHINES;
    for (let slot = 0; slot < 3; slot++) {
      const seed = fnv(`${date}|${slot}`);
      const machine = active[seed % active.length] ?? MACHINES[0];
      if (!machine) continue;
      const hour = 9 + slot * 2 + ((seed >>> 4) % 2);
      const at = bst(date, `${String(hour).padStart(2, '0')}:${String((seed >>> 8) % 60).padStart(2, '0')}`);
      const job = JOBS[(seed >>> 12) % JOBS.length] ?? JOBS[0];
      if (!job) continue;
      const kind = (seed >>> 16) % 4;
      const question =
        kind === 0 ? `Can you find the survey report for ${job.address}? It is job ${job.job}.`
        : kind === 1 ? `What files are in the job folder for ${job.job}?`
        : kind === 2 ? 'What is in my Documents folder? I am looking for the September rota.'
        : `Open the instruction letter for job ${job.job} and tell me the client address.`;
      sessions.push({ at, machine, question });
    }
  }
  const branch = MACHINES.find((machine) => machine.name === 'HS-BRANCH-04');
  const pilot = MACHINES.find((machine) => machine.name === 'HS-MAIN-PILOT-01');
  if (branch && pilot) {
    // The request in the complaint, and the same folder asked for on a pilot machine the next day.
    sessions.push({ at: bst('2026-09-17', '11:05'), machine: branch, question: 'Can you find the previous survey for 7 Craigend Road? We inspected it in 2024, job HS-2024-0187.' });
    sessions.push({ at: bst('2026-09-18', '10:20'), machine: pilot, question: 'Can you list the folder for job HS-2024-0187, the 2024 survey at 7 Craigend Road?' });
  }
  return sessions.sort((a, b) => a.at - b.at);
}

export async function recordCase09(variant: 'incident' | 'fixed', mode: RecordingMode = { kind: 'stub' }): Promise<Recording> {
  const faults = variant === 'incident' ? new FaultPlan([{ name: 'scope_removed' }]) : FaultPlan.none();
  const env = makeEnv(EPOCH, 9_009, faults, mode);
  const faulted: string[] = [];
  const sessions = schedule();
  // The sync service's own status: a morning check per office per working day, and the outage on 15 September.
  const infra: Array<{ at: number; run: () => void }> = [];
  for (const date of [...new Set(sessions.map((session) => new Date(session.at + 3_600_000).toISOString().slice(0, 10)))]) {
    for (const office of ['main', 'branch']) {
      infra.push({
        at: bst(date, office === 'main' ? '07:00' : '07:02'),
        run: () => {
          const span = env.trace.start('file sync check', 'internal', env.trace.newTraceId(), undefined, {
            'deployment.environment.name': 'production',
            attributes: { 'sync.office': office, 'sync.state': 'complete', 'sync.drive': SHARED },
          });
          env.clock.advance(400);
          env.trace.end(span);
        },
      });
    }
  }
  infra.push({
    at: OUTAGE.from,
    run: () => {
      const span = env.trace.start('file sync outage', 'internal', env.trace.newTraceId(), undefined, {
        'deployment.environment.name': 'production',
        attributes: { 'sync.state': 'outage', 'sync.drive': SHARED, 'sync.restored_at': new Date(OUTAGE.until).toISOString(), 'sync.files_missing_after': 0 },
      });
      // The outage span covers the two hours; sessions during it run on their own traces.
      env.clock.advance(1_000);
      env.trace.end(span, { 'error.type': 'sync_outage' });
    },
  });
  infra.sort((a, b) => a.at - b.at);
  for (const session of sessions) {
    while (infra.length > 0 && (infra[0]?.at ?? Infinity) <= session.at) {
      const item = infra.shift();
      if (!item) break;
      env.clock.set(Math.max(item.at, env.clock.now()));
      item.run();
    }
    env.clock.set(Math.max(session.at, env.clock.now()));
    const sink = { emptyOutOfScope: false };
    const config: AgentConfig = {
      name: 'desktop-assistant',
      model: env.model,
      system: SYSTEM,
      tools: tools(session.machine, sink),
      maxTurns: 6,
      maxTokens: 1024,
      client: env.client,
      clock: env.clock,
      trace: env.trace,
      faults: env.faults,
    };
    const result = await ask(env, config, {
      identity: { subject: session.machine.user, role: 'office-administrator', tenant: 'hepburn-strachan' },
      // The desktop app knows who is signed in, and says so, as it would in production.
      question: `(Signed in as ${session.machine.user} on ${session.machine.name}; your Documents folder is ${documents(session.machine)}.) ${session.question}`,
      fields: {
        'deployment.environment.name': 'production',
        attributes: { 'device.name': session.machine.name, 'device.office': session.machine.office, 'connector.allowed_roots': grantedRoots(session.machine).join(';'), 'connector.version': '1.4.2' },
      },
    });
    if (sink.emptyOutOfScope) faulted.push(result.traceId);
  }
  return {
    header: env.header({
      caseId: CASE_ID,
      variant,
      epochIso: EPOCH,
      redactions: [{ field: 'staff identity', method: 'replaced with role-based user names' }],
    }),
    events: env.trace.events(),
    blobs: env.trace.blobs,
    faultedTraceIds: faulted,
  };
}
