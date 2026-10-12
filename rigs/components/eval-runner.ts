import type { Clock } from '../clock.js';
import type { FaultPlan } from '../faults.js';
import type { TraceWriter } from '../trace-writer.js';
import type { Handler, HttpAdapter, HttpRequest } from './http-adapter.js';

export interface EvalCase {
  id: string;
  question: string;
  attachmentBytes: number;
  /** The answer must contain this text, or match this pattern, to pass. */
  expect: string | RegExp;
}

export interface EvalResult {
  caseId: string;
  passed: boolean;
  status: number;
  traceId: string;
}

export interface EvalRunnerOptions {
  suite: string;
  adapter: HttpAdapter;
  handler: Handler;
  trace: TraceWriter;
  clock: Clock;
  faults: FaultPlan;
  /** Bearer token for the eval's own test account, used on the HTTP path. */
  testToken: string;
  userAgent: string;
}

/**
 * Correct behaviour: the eval goes through the same HTTP adapter as production traffic.
 * Fault in_process_eval_bypass: the eval calls the handler directly, so body limits and auth
 * never run, and it identifies itself with a header no real client sends.
 */
export async function runEvalCase(evalCase: EvalCase, options: EvalRunnerOptions): Promise<EvalResult> {
  const { trace, clock } = options;
  const traceId = trace.newTraceId();
  const root = trace.start(`eval ${options.suite}/${evalCase.id}`, 'internal', traceId, undefined, {
    'deployment.environment.name': 'eval',
    attributes: { 'eval.suite': options.suite, 'eval.case_id': evalCase.id },
  });
  const body = JSON.stringify({ question: evalCase.question, attachments: evalCase.attachmentBytes > 0 ? ['site-plan.pdf'] : [] });
  const bodyBytes = body.length + evalCase.attachmentBytes;
  const bypass = options.faults.active('in_process_eval_bypass', clock.now());
  const request: HttpRequest = bypass
    ? { method: 'POST', route: '/v1/ask', headers: { 'content-type': 'application/json', 'x-eval-user': 'eval-bot' }, body, bodyBytes }
    : {
        method: 'POST',
        route: '/v1/ask',
        headers: {
          authorization: `Bearer ${options.testToken}`,
          'content-type': 'application/json',
          'user-agent': options.userAgent,
          'x-request-id': trace.newTraceId().slice(0, 12),
        },
        body,
        bodyBytes,
      };
  const response = bypass
    ? await options.handler(request, { identity: null, traceId, parentSpanId: root.spanId })
    : await options.adapter.handle(request, traceId, root.spanId);
  const matches = typeof evalCase.expect === 'string' ? response.body.includes(evalCase.expect) : evalCase.expect.test(response.body);
  const passed = response.status === 200 && matches;
  trace.end(root, {
    ...(passed ? {} : { 'error.type': 'eval_failed' }),
    attributes: { 'eval.suite': options.suite, 'eval.case_id': evalCase.id, 'eval.passed': passed },
  });
  return { caseId: evalCase.id, passed, status: response.status, traceId };
}
