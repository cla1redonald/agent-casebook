/**
 * Named faults the rig can inject. Each one is a switch read by exactly one component;
 * the component holds both the faulty and the corrected behaviour side by side.
 */
export const FAULT_NAMES = [
  'stale_cache',
  'upstream_503_silent_fallback',
  'schema_field_rename',
  'scope_removed',
  'injected_tool_result',
  'retry_without_backoff',
  'router_by_length',
  'context_overflow_compaction_drop',
  'approval_latency',
  'in_process_eval_bypass',
] as const;

export type FaultName = (typeof FAULT_NAMES)[number];

export const FAULT_CATALOGUE: Record<FaultName, { component: string; behaviour: string }> = {
  stale_cache: {
    component: 'components/response-cache.ts',
    behaviour: 'Cache hits ignore entry age and the policy version is left out of the key.',
  },
  upstream_503_silent_fallback: {
    component: 'components/upstream.ts',
    behaviour: 'On a 5xx the tool returns a static snapshot with an ok status and does not tell the model.',
  },
  schema_field_rename: {
    component: 'components/schema-drift.ts',
    behaviour: 'A server release changes a money field from pounds (float) to pence (integer) under the same name.',
  },
  scope_removed: {
    component: 'components/connector.ts',
    behaviour: 'A connector without folder permission lists nothing and raises no error.',
  },
  injected_tool_result: {
    component: 'components/injection.ts',
    behaviour: 'A fetched page carries an instruction that is passed to the model as tool output.',
  },
  retry_without_backoff: {
    component: 'components/retry.ts',
    behaviour: 'Failed model calls are retried at once, many times, with the whole context resent.',
  },
  router_by_length: {
    component: 'components/router.ts',
    behaviour: 'The model router picks the small model for short inputs, whatever the task.',
  },
  context_overflow_compaction_drop: {
    component: 'components/compaction.ts',
    behaviour: 'The compaction summary keeps facts and drops standing constraints.',
  },
  approval_latency: {
    component: 'components/approval.ts',
    behaviour: 'The approval step returns in well under a second with clarifying questions dismissed.',
  },
  in_process_eval_bypass: {
    component: 'components/eval-runner.ts',
    behaviour: 'The eval calls the handler in-process, skipping the HTTP adapter that enforces body size and auth.',
  },
};

export interface FaultWindow {
  name: FaultName;
  /** Absolute simulated time the fault switches on. Omit for always on. */
  fromMs?: number;
  /** Absolute simulated time the fault switches off. Omit for never. */
  untilMs?: number;
}

export class FaultPlan {
  constructor(private readonly windows: readonly FaultWindow[]) {}

  static none(): FaultPlan {
    return new FaultPlan([]);
  }

  active(name: FaultName, atMs: number): boolean {
    return this.windows.some(
      (window) =>
        window.name === name && (window.fromMs === undefined || atMs >= window.fromMs) && (window.untilMs === undefined || atMs < window.untilMs),
    );
  }

  names(): FaultName[] {
    return [...new Set(this.windows.map((window) => window.name))];
  }
}
