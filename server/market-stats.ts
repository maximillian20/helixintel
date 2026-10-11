/** Small, dependency-free statistics helpers. */

export const median = (values: number[]) => quantile(values, 0.5);

export function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function stdev(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1));
}

function logChoose(n: number, k: number) {
  let sum = 0;
  for (let i = 1; i <= k; i += 1) sum += Math.log(n - k + i) - Math.log(i);
  return sum;
}

/** Exact two-sided sign test (p = 0.5) on the non-zero values. Returns null when there is nothing to test. */
export function signTestP(values: number[]): number | null {
  const pos = values.filter((v) => v > 0).length, neg = values.filter((v) => v < 0).length;
  const n = pos + neg;
  if (n === 0) return null;
  const k = Math.min(pos, neg);
  let tail = 0;
  for (let i = 0; i <= k; i += 1) tail += Math.exp(logChoose(n, i) - n * Math.LN2);
  return Math.min(1, 2 * tail);
}

/** Holm-Bonferroni step-down adjustment; returns adjusted p-values in the input order. */
export function holmAdjust(p: number[]): number[] {
  const order = p.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const adjusted = new Array<number>(p.length);
  let running = 0;
  order.forEach((entry, rank) => {
    running = Math.max(running, Math.min(1, entry.value * (p.length - rank)));
    adjusted[entry.index] = running;
  });
  return adjusted;
}

function erf(x: number) {
  const sign = x < 0 ? -1 : 1, ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}
export const normalCdf = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));

export function pearson(x: number[], y: number[]): number | null {
  const n = x.length;
  if (n < 3 || y.length !== n) return null;
  const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i += 1) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  if (sxx === 0 || syy === 0) return null; // a constant series has no defined correlation
  return sxy / Math.sqrt(sxx * syy);
}

function ranks(values: number[]) {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const out = new Array<number>(values.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1].value === order[i].value) j += 1;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) out[order[k].index] = rank;
    i = j + 1;
  }
  return out;
}
export const spearman = (x: number[], y: number[]) => pearson(ranks(x), ranks(y));

/** 95% Fisher-z confidence interval and a two-sided p-value for a correlation r from n pairs (normal approximation). */
export function fisherInference(r: number, n: number): { ci: [number, number]; p: number } | null {
  if (n < 4 || Math.abs(r) >= 1) return null;
  const z = Math.atanh(r), se = 1 / Math.sqrt(n - 3);
  return { ci: [Math.tanh(z - 1.96 * se), Math.tanh(z + 1.96 * se)], p: 2 * (1 - normalCdf(Math.abs(z) / se)) };
}
