import type { Clock } from '../clock.js';
import type { FaultPlan } from '../faults.js';
import type { TraceWriter } from '../trace-writer.js';

export interface ApprovalRequest {
  diffLines: number;
  /** Clarifying questions the agent raised before asking for approval. */
  questions: readonly string[];
}

export interface ApprovalDecision {
  approved: boolean;
  latencyMs: number;
  questionsAnswered: number;
  questionsDismissed: number;
}

/**
 * A simulated human approval step, recorded as its own span.
 * Correct behaviour: review time scales with the diff and questions get answers.
 * Fault approval_latency: approval lands in 400 ms with every question dismissed, the pattern
 * a person falls into when the tool asks for approval dozens of times an hour.
 */
export async function requestApproval(
  request: ApprovalRequest,
  context: { trace: TraceWriter; clock: Clock; faults: FaultPlan; traceId: string; parentSpanId: string },
): Promise<ApprovalDecision> {
  const span = context.trace.start('approval review', 'internal', context.traceId, context.parentSpanId);
  const fatigued = context.faults.active('approval_latency', context.clock.now());
  const latencyMs = fatigued ? 400 : 20_000 + request.diffLines * 1_500;
  context.clock.advance(latencyMs);
  const decision: ApprovalDecision = {
    approved: true,
    latencyMs,
    questionsAnswered: fatigued ? 0 : request.questions.length,
    questionsDismissed: fatigued ? request.questions.length : 0,
  };
  context.trace.end(span, {
    attributes: {
      'approval.decision': 'approved',
      'approval.latency_ms': latencyMs,
      'approval.diff_lines': request.diffLines,
      'approval.questions_answered': decision.questionsAnswered,
      'approval.questions_dismissed': decision.questionsDismissed,
    },
  });
  return decision;
}
