import { join, dirname, resolve } from "node:path";
import { parsePattern, start, step, accepts, alive, namesLiterally } from "../lib/glob.mjs";
import { relSegments } from "../lib/config.mjs";

const PACKAGE_FOLDER = new Set(["node_modules", "bower_components", "jspm_packages"]);
const SOURCE_EXTENSION = /\.(?:ts|tsx|mts|cts)$/;
const HAS_EXTENSION = /\.[A-Za-z0-9]+$/;
const RELATIVE_SPECIFIER =
  /(?:^|[^A-Za-z0-9_$])(?:import|export)\s*(?:[\s\S]*?\sfrom\s*)?["']([^"']+)["']/g;

export const findConfig = (fs, from) => {
  let dir = from;
  for (;;) {
    const candidate = join(dir, "tsconfig.json");
    if (fs.exists(candidate)) return candidate;
    const up = dirname(dir);
    if (up === dir) throw new Error(`no_tsconfig_above:${from}`);
    dir = up;
  }
};

const openDirectory = (fs, order, ctx, dir) => {
  ctx.opendir += 1;
  ctx.trace.push(dir);
  return order(fs.readdir(dir), dir);
};

const cursorsOf = (patterns) =>
  patterns.map((pattern) => ({ pattern, states: start(pattern.segs) }));

const descend = (cursors, name) =>
  cursors.map((cursor) => ({
    pattern: cursor.pattern,
    states: step(cursor.pattern.segs, cursor.states, name),
  }));

const cursorsAt = (patterns, base, dir) => {
  let cursors = cursorsOf(patterns);
  for (const name of relSegments(base, dir)) cursors = descend(cursors, name);
  return cursors;
};

const anyAccepts = (cursors) =>
  cursors.some((cursor) => accepts(cursor.pattern.segs, cursor.states));

const anyAlive = (cursors) => cursors.some((cursor) => alive(cursor.pattern.segs, cursor.states));

const subtreeExcluded = (cursors) =>
  cursors.some(
    (cursor) =>
      accepts(cursor.pattern.segs, cursor.states) ||
      (cursor.pattern.dirPrefix !== null && cursor.states.has(cursor.pattern.dirPrefix))
  );

const namedLiterally = (cursors, name) =>
  cursors.some((cursor) => namesLiterally(cursor.pattern.segs, cursor.states, name));

const includeSpecsOf = (cfg) =>
  Array.isArray(cfg.include) ? cfg.include : Array.isArray(cfg.files) ? [] : ["**/*"];

const literalBaseOf = (spec, base) => {
  const parts = [];
  for (const segment of String(spec).replace(/\\/g, "/").replace(/^\.\//, "").split("/")) {
    if (segment.includes("*") || segment.includes("?")) break;
    parts.push(segment);
  }
  const path = resolve(base, parts.join("/"));
  return HAS_EXTENSION.test(path) ? dirname(path) : path;
};

const outermost = (paths) =>
  paths.filter((path, i) => !paths.some((other, j) => j !== i && path.startsWith(`${other}/`)));

const includeRootsOf = (include, base) =>
  outermost([...new Set(include.map((pattern) => literalBaseOf(pattern.source, base)))]);

const collectRootSet = (fs, order, ctx, base, cfg) => {
  const include = includeSpecsOf(cfg).map((spec) => parsePattern(String(spec), base, fs));
  const exclude = (Array.isArray(cfg.exclude) ? cfg.exclude : []).map((spec) =>
    parsePattern(String(spec), base, fs)
  );
  const walk = (dir, inc, exc) => {
    for (const entry of openDirectory(fs, order, ctx, dir)) {
      const path = join(dir, entry.name);
      const nextInc = descend(inc, entry.name);
      const nextExc = descend(exc, entry.name);
      if (entry.dir) {
        if (subtreeExcluded(nextExc)) continue;
        if (PACKAGE_FOLDER.has(entry.name) && !namedLiterally(inc, entry.name)) continue;
        if (!anyAlive(nextInc)) continue;
        walk(path, nextInc, nextExc);
        continue;
      }
      if (!SOURCE_EXTENSION.test(entry.name)) continue;
      if (anyAccepts(nextExc)) continue;
      if (anyAccepts(nextInc)) ctx.files.add(path);
    }
  };

  for (const spec of Array.isArray(cfg.files) ? cfg.files : []) {
    const path = resolve(base, String(spec));
    if (!fs.exists(path) || fs.isDirectory(path)) throw new Error(`files_entry_not_a_file:${path}`);
    ctx.files.add(path);
  }

  for (const dir of includeRootsOf(include, base)) {
    if (!fs.isDirectory(dir)) continue;
    const exc = cursorsAt(exclude, base, dir);
    if (subtreeExcluded(exc)) continue;
    walk(dir, cursorsAt(include, base, dir), exc);
  }
};

const resolutionCandidates = (target) => [
  target,
  target.replace(/\.js$/, ".ts"),
  target.replace(/\.js$/, ".tsx"),
  target.replace(/\.js$/, ".d.ts"),
  `${target}.ts`,
  `${target}.tsx`,
  `${target}.d.ts`,
  `${target}.mts`,
  `${target}.cts`,
  join(target, "index.ts"),
  join(target, "index.tsx"),
  join(target, "index.d.ts"),
];

const relativeSpecifiersOf = (text) => {
  const out = [];
  for (const match of text.matchAll(RELATIVE_SPECIFIER)) out.push(match[1]);
  return out.filter((spec) => spec.startsWith("./") || spec.startsWith("../"));
};

const followImports = (fs, ctx) => {
  const seen = new Set();
  const queue = [...ctx.files];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of relativeSpecifiersOf(fs.readFile(file))) {
      const target = resolve(dirname(file), spec);
      const hit = resolutionCandidates(target).find(
        (candidate) =>
          SOURCE_EXTENSION.test(candidate) && fs.exists(candidate) && !fs.isDirectory(candidate)
      );
      if (hit === undefined) continue;
      ctx.files.add(hit);
      queue.push(hit);
    }
  }
};

export const tscResolve = (fs, entryFile, corpus, order) => {
  const config = findConfig(fs, dirname(entryFile));
  const root = dirname(config);
  const ctx = { opendir: 0, trace: [], files: new Set() };

  collectRootSet(fs, order, ctx, root, fs.readJSON(config));
  followImports(fs, ctx);

  return { files: ctx.files, opendir: ctx.opendir, trace: ctx.trace, root };
};
