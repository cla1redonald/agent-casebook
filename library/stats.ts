export interface Interval {
  low: number;
  high: number;
}

/** Wilson score interval for k successes in n trials. Returns [0, 1] when n is 0. */
export function wilson(k: number, n: number, z = 1.96): Interval {
  if (n === 0) return { low: 0, high: 1 };
  const p = k / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return { low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) };
}

export function formatInterval(interval: Interval, digits = 2): string {
  return `[${interval.low.toFixed(digits)}, ${interval.high.toFixed(digits)}]`;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}
