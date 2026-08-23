import { join, dirname, resolve } from "node:path";
import { findWorkspaceRoot, workspaceMembers } from "../lib/config.mjs";

const WORKSPACE_SKIP = new Set(["node_modules", "vendor", "coverage", ".git"]);
const SPECIFIER_SKIP = "node_modules";
const COLLECTOR_SKIP = new Set(["node_modules", ".git"]);
const DENO_MEMBER_CONFIGS = Object.freeze(["deno.json", "deno.jsonc", "package.json"]);
const NPM_MEMBER_CONFIGS = Object.freeze(["package.json"]);
const SCRIPT_EXTENSION = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const WILDCARD = /[*?]/;
const ANY_SEGMENTS = { any: true };

const segmentsOf = (path) => path.split("/").filter((segment) => segment.length > 0);

const segmentMatcher = (segment) => {
  let source = "^";
  for (const ch of segment) {
    if (ch === "*") source += "[^/]*";
    else if (ch === "?") source += "[^/]";
    else source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${source}$`);
};

const parseGlob = (text) => ({
  text,
  segs: segmentsOf(text).map((segment) =>
    segment === "**" ? ANY_SEGMENTS : segmentMatcher(segment)
  ),
});

const globMatches = (segs, path) => {
  let states = new Set([0]);
  for (const name of segmentsOf(path)) {
    const next = new Set();
    for (const i of states) {
      const seg = segs[i];
      if (seg === undefined) continue;
      if (seg === ANY_SEGMENTS) {
        next.add(i);
        next.add(i + 1);
      } else if (seg.test(name)) next.add(i + 1);
    }
    states = next;
  }
  return states.has(segs.length);
};

const literalPrefix = (text) => {
  const parts = [];
  for (const segment of segmentsOf(text)) {
    if (WILDCARD.test(segment)) break;
    parts.push(segment);
  }
  return `/${parts.join("/")}`;
};

const parsePattern = (spec, base) => {
  const text = resolve(base, String(spec).replace(/\/+$/, ""));
  return WILDCARD.test(text) ? { glob: parseGlob(text), path: null } : { glob: null, path: text };
};

const under = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);

const matches = (pattern, path) =>
  pattern.glob === null ? under(path, pattern.path) : globMatches(pattern.glob.segs, path);

const walkRootOf = (pattern) =>
  pattern.glob === null ? pattern.path : literalPrefix(pattern.glob.text);

const openDirectory = (fs, order, ctx, dir) => {
  ctx.opendir += 1;
  ctx.opens[ctx.phase] += 1;
  ctx.trace.push(dir);
  ctx.phases.push(ctx.phase);
  return order(fs.readdir(dir), dir);
};

const isPatternMember = (spec) => WILDCARD.test(spec) || spec.startsWith("!");

const memberPattern = (spec, base, configName) => {
  if (spec.startsWith("!")) throw new Error(`negated_workspace_member:${spec}`);
  return parsePattern(`${spec.replace(/\/+$/, "")}/${configName}`, base);
};

const groupByBase = (patterns) => {
  const groups = new Map();
  for (const pattern of patterns) {
    const base = walkRootOf(pattern);
    const held = groups.get(base);
    if (held === undefined) groups.set(base, [pattern]);
    else held.push(pattern);
  }
  return groups;
};

const isIgnoredDir = (name, path, vendorFolder) =>
  COLLECTOR_SKIP.has(name.toLowerCase()) || path === vendorFolder;

const collectMemberConfigFolders = (fs, order, ctx, specs, base, configNames, vendorFolder) => {
  const patterns = specs
    .filter(isPatternMember)
    .flatMap((spec) => configNames.map((name) => memberPattern(spec, base, name)));
  const found = [];
  const visited = new Set();
  for (const [start, group] of groupByBase(patterns)) {
    if (!fs.isDirectory(start)) continue;
    if (visited.has(start)) continue;
    visited.add(start);
    const queue = [start];
    for (let at = 0; at < queue.length; at += 1) {
      const dir = queue[at];
      for (const entry of openDirectory(fs, order, ctx, dir)) {
        const path = join(dir, entry.name);
        if (entry.dir) {
          if (isIgnoredDir(entry.name, path, vendorFolder)) continue;
          if (visited.has(path)) continue;
          visited.add(path);
          queue.push(path);
          continue;
        }
        if (group.some((pattern) => matches(pattern, path))) found.push(path);
      }
    }
  }
  return found;
};

const npmMemberSpecs = (fs, root) => {
  const path = join(root, "package.json");
  if (!fs.exists(path)) return [];
  const specs = fs.readJSON(path).workspaces;
  if (specs === undefined) return [];
  if (!Array.isArray(specs)) throw new Error(`unmodelled_workspaces_shape:${path}`);
  return specs.map(String);
};

const expandGlobMembers = (fs, order, ctx, root) => {
  const denoConfig = fs.readJSON(join(root, "deno.json"));
  const vendorFolder = denoConfig.vendor === true ? join(root, "vendor") : null;
  const found = [
    ...collectMemberConfigFolders(
      fs,
      order,
      ctx,
      denoConfig.workspace.map(String),
      root,
      DENO_MEMBER_CONFIGS,
      vendorFolder
    ),
    ...collectMemberConfigFolders(
      fs,
      order,
      ctx,
      npmMemberSpecs(fs, root),
      root,
      NPM_MEMBER_CONFIGS,
      vendorFolder
    ),
  ];
  return [...new Set(found.map((path) => dirname(path)))].sort();
};

const includeSpecsOf = (cfg, base) =>
  Array.isArray(cfg.include) ? cfg.include : Array.isArray(cfg.files) ? [] : [base];

const walkWorkspace = (fs, order, ctx, root) => {
  const walk = (dir) => {
    for (const entry of openDirectory(fs, order, ctx, dir)) {
      const path = join(dir, entry.name);
      if (entry.dir) {
        if (!WORKSPACE_SKIP.has(entry.name)) walk(path);
        continue;
      }
      if (SCRIPT_EXTENSION.test(entry.name)) ctx.files.add(path);
    }
  };
  walk(root);
};

const collectSpecifiers = (fs, order, ctx, base, cfg) => {
  const includes = includeSpecsOf(cfg, base).map((spec) => parsePattern(spec, base));
  const excludes = (Array.isArray(cfg.exclude) ? cfg.exclude : []).map((spec) =>
    parsePattern(spec, base)
  );
  const included = (path) => includes.some((pattern) => matches(pattern, path));
  const excluded = (path) => excludes.some((pattern) => matches(pattern, path));
  const walk = (dir) => {
    for (const entry of openDirectory(fs, order, ctx, dir)) {
      const path = join(dir, entry.name);
      if (excluded(path)) continue;
      if (entry.dir) {
        if (entry.name === SPECIFIER_SKIP) continue;
        walk(path);
        continue;
      }
      if (SCRIPT_EXTENSION.test(entry.name) && included(path)) ctx.files.add(path);
    }
  };
  for (const pattern of includes) {
    const start = walkRootOf(pattern);
    if (excluded(start)) continue;
    if (fs.isDirectory(start)) {
      walk(start);
      continue;
    }
    if (fs.exists(start) && SCRIPT_EXTENSION.test(start)) ctx.files.add(start);
  }
};

const collectTsconfigAt = (fs, order, ctx, base) => {
  const config = join(base, "tsconfig.json");
  if (!fs.exists(config)) return;
  collectSpecifiers(fs, order, ctx, base, fs.readJSON(config));
};

export const denoResolve = (fs, entryFile, corpus, order) => {
  const root = findWorkspaceRoot(fs, dirname(entryFile));
  const ctx = {
    opendir: 0,
    trace: [],
    phases: [],
    opens: { T0: 0, T1: 0, T2: 0, T3: 0 },
    phase: "T0",
    files: new Set(),
  };

  const globMembers = expandGlobMembers(fs, order, ctx, root);
  ctx.phase = "T1";
  walkWorkspace(fs, order, ctx, root);
  ctx.phase = "T2";
  collectTsconfigAt(fs, order, ctx, root);
  ctx.phase = "T3";
  for (const member of workspaceMembers(fs, root)) collectTsconfigAt(fs, order, ctx, member);

  return {
    files: ctx.files,
    opendir: ctx.opendir,
    trace: ctx.trace,
    phases: ctx.phases,
    opens: ctx.opens,
    globMembers,
    root,
  };
};
