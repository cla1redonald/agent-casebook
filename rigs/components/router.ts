import { textOf, type Message } from '../client.js';
import type { Clock } from '../clock.js';
import type { FaultPlan } from '../faults.js';

export type Difficulty = 'routine' | 'specialist';

export interface RouterOptions {
  smallModel: string;
  largeModel: string;
  /** Classifies the task. Supplied by the scenario, for example a keyword list. */
  classify: (text: string) => Difficulty;
  lengthThreshold?: number;
  clock: Clock;
  faults: FaultPlan;
}

/**
 * Correct behaviour: route on the task's difficulty.
 * Fault router_by_length: route on input length, so short hard questions go to the small model.
 */
export function makeRouter(options: RouterOptions): (messages: Message[]) => string {
  const threshold = options.lengthThreshold ?? 280;
  return (messages) => {
    const first = messages.find((message) => message.role === 'user');
    const text = first ? textOf(first.content) : '';
    if (options.faults.active('router_by_length', options.clock.now())) {
      return text.length < threshold ? options.smallModel : options.largeModel;
    }
    return options.classify(text) === 'specialist' ? options.largeModel : options.smallModel;
  };
}
