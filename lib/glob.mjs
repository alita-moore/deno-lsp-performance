const SEG_ANY = { any: true };

const isLiteral = (seg) => !seg.includes("*") && !seg.includes("?");

const segRegex = (seg) => {
  let out = "^";
  for (const ch of seg) {
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(out + "$");
};

import { join } from "node:path";

const LOOKS_LIKE_FILE = /\.[A-Za-z0-9]+$/;

const isDirectoryOnDisk = (fs, base, rel) => fs.isDirectory(join(base, rel));

export const parsePattern = (pattern, base, fs) => {
  const raw = pattern.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const directoryLike =
    !raw.includes("*") &&
    (isDirectoryOnDisk(fs, base, raw) || !LOOKS_LIKE_FILE.test(raw));
  const text = directoryLike ? `${raw}/**/*` : raw;
  const segs = text
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => (s === "**" ? SEG_ANY : { re: segRegex(s), literal: isLiteral(s) }));
  const dirPrefix = directoryLike ? segs.length - 2 : null;
  return { segs, dirPrefix, source: pattern };
};

const close = (segs, states) => {
  const out = new Set();
  const stack = [...states];
  while (stack.length > 0) {
    const i = stack.pop();
    if (out.has(i)) continue;
    out.add(i);
    if (segs[i] === SEG_ANY) stack.push(i + 1);
  }
  return out;
};

export const start = (segs) => close(segs, [0]);

export const step = (segs, states, name) => {
  const next = new Set();
  for (const i of states) {
    const seg = segs[i];
    if (seg === undefined) continue;
    if (seg === SEG_ANY) next.add(i);
    else if (seg.re.test(name)) next.add(i + 1);
  }
  return close(segs, next);
};

export const namesLiterally = (segs, states, name) => {
  for (const i of states) {
    const seg = segs[i];
    if (seg !== undefined && seg !== SEG_ANY && seg.literal && seg.re.test(name)) return true;
  }
  return false;
};

export const accepts = (segs, states) => states.has(segs.length);
export const alive = (segs, states) => {
  for (const i of states) if (i < segs.length) return true;
  return false;
};
