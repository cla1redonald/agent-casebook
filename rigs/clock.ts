/** Time source for the rig. Stub recordings use a simulated clock so traces are reproducible. */
export interface Clock {
  now(): number;
  advance(ms: number): void;
}

export class SimClock implements Clock {
  private current: number;
  constructor(readonly epochMs: number) {
    this.current = epochMs;
  }
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    if (ms < 0) throw new Error('A simulated clock cannot run backwards.');
    this.current += Math.round(ms);
  }
  /** Jumps forward to an absolute time. Used between sessions. */
  set(ms: number): void {
    if (ms < this.current) throw new Error('A simulated clock cannot run backwards.');
    this.current = ms;
  }
}

/** Deterministic PRNG (mulberry32). Same seed, same recording. */
export class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  pick<T>(items: readonly T[]): T {
    const item = items[Math.floor(this.next() * items.length)];
    if (item === undefined) throw new Error('Cannot pick from an empty list.');
    return item;
  }
  hex(chars: number): string {
    let out = '';
    while (out.length < chars) out += Math.floor(this.next() * 16).toString(16);
    return out;
  }
}
