import { dirname, resolve } from "node:path";

const SPECIFIER = /(?:^|[\s;])(?:import|export)\s[^'"\n]*?from\s*["']([^"']+)["']|(?:^|[\s;])import\s*["']([^"']+)["']/g;

const candidatesOf = (target) => {
  const rewritten = target.replace(/\.(?:js|mjs|cjs|jsx)$/, "");
  return [
    target,
    `${rewritten}.ts`,
    `${rewritten}.tsx`,
    `${rewritten}.mts`,
    `${rewritten}.d.ts`,
    `${target}.ts`,
    `${target}/index.ts`,
  ];
};

const resolveSpecifier = (fs, fromFile, specifier) => {
  if (!specifier.startsWith(".")) return null;
  const target = resolve(dirname(fromFile), specifier);
  for (const candidate of candidatesOf(target)) if (fs.exists(candidate)) return candidate;
  return null;
};

export const importClosure = (fs, roots) => {
  const seen = new Set(roots);
  const queue = [...roots];
  for (let at = 0; at < queue.length; at += 1) {
    const file = queue[at];
    if (!fs.exists(file)) continue;
    const text = fs.readFile(file);
    SPECIFIER.lastIndex = 0;
    for (;;) {
      const match = SPECIFIER.exec(text);
      if (match === null) break;
      const specifier = match[1] ?? match[2];
      const target = resolveSpecifier(fs, file, specifier);
      if (target === null || seen.has(target)) continue;
      seen.add(target);
      queue.push(target);
    }
  }
  return seen;
};
