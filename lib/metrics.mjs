export const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};

export const sameTrace = (a, b) => a.length === b.length && a.every((dir, i) => dir === b[i]);

export const sameFiles = (a, b) => a.size === b.size && [...a].every((file) => b.has(file));

export const timed = (fn, warmup, repeats) => {
  for (let i = 0; i < warmup; i += 1) fn();
  const samples = [];
  let last = null;
  for (let i = 0; i < repeats; i += 1) {
    const at = process.hrtime.bigint();
    last = fn();
    samples.push(Number(process.hrtime.bigint() - at) / 1000);
  }
  return { result: last, samples };
};

export const dirsOf = (nodes) =>
  [...nodes.keys()].filter((path) => nodes.get(path).children !== undefined);

export const pad = (value, width) => String(value).padEnd(width);
export const rpad = (value, width) => String(value).padStart(width);
export const fix = (value, digits) => value.toFixed(digits);
export const pct = (part, whole) => `${((100 * part) / whole).toFixed(1)}%`;
export const yesNo = (value) => (value ? "yes" : "no");
