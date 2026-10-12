import { textOf, type Message } from '../client.js';
import type { FaultPlan } from '../faults.js';

const CONSTRAINT = /^constraint:/i;
const FACT = /^fact:/i;

/**
 * Replaces older messages with a summary once the conversation passes a size budget.
 * Correct behaviour: standing constraints are carried into the summary word for word.
 * Fault context_overflow_compaction_drop: the summary keeps facts and drops constraints.
 */
export function compact(
  messages: readonly Message[],
  options: { keepRecent: number; faults: FaultPlan; atMs: number },
): { messages: Message[]; dropped: string[] } {
  if (messages.length <= options.keepRecent) return { messages: [...messages], dropped: [] };
  const older = messages.slice(0, messages.length - options.keepRecent);
  const recent = messages.slice(messages.length - options.keepRecent);
  const lines = older.flatMap((message) => textOf(message.content).split('\n').map((line) => line.trim()));
  const facts = lines.filter((line) => FACT.test(line));
  const constraints = lines.filter((line) => CONSTRAINT.test(line));
  const dropConstraints = options.faults.active('context_overflow_compaction_drop', options.atMs);
  const kept = dropConstraints ? facts : [...constraints, ...facts];
  const summary: Message = { role: 'user', content: ['Summary of the earlier conversation:', ...kept.map((line) => `- ${line}`)].join('\n') };
  // Keep the alternation valid: a summary (user) must be followed by an assistant message.
  const head: Message[] = recent[0]?.role === 'user' ? [summary, { role: 'assistant', content: 'Noted.' }] : [summary];
  return { messages: [...head, ...recent], dropped: dropConstraints ? constraints : [] };
}
