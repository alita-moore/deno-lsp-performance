import { join, dirname, resolve } from "node:path";
import { findWorkspaceRoot, workspaceMembers } from "../../lib/config.mjs";
import { baseIgnore, pruneChain, under } from "./discovery.mjs";

const WORKSPACE_SKIP = new Set(["node_modules", "vendor", "coverage", ".git"]);
const SPECIFIER_SKIP = "node_modules";
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

const stepStates = (segs, states, name) => {
  const next = new Set();
  for (const i of states) {
    const seg = segs[i];
    if (seg === undefined) continue;
    if (seg === ANY_SEGMENTS) {
      next.add(i);
      next.add(i + 1);
    } else if (seg.test(name)) next.add(i + 1);
  }
  return next;
};

const globMatches = (segs, path) => {
  let states = new Set([0]);
  for (const name of segmentsOf(path)) states = stepStates(segs, states, name);
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

const statesAt = (group, path) =>
  group.map((pattern) =>
    pattern.glob === null
      ? { pattern, states: null }
      : { pattern, states: segmentsOf(path).reduce((s, n) => stepStates(pattern.glob.segs, s, n), new Set([0])) }
  );

const stillAlive = (cursors) =>
  cursors.some((cursor) =>
    cursor.states === null
      ? true
      : [...cursor.states].some((i) => i < cursor.pattern.glob.segs.length)
  );

const stepCursors = (cursors, name) =>
  cursors.map((cursor) => ({
    pattern: cursor.pattern,
    states:
      cursor.states === null ? null : stepStates(cursor.pattern.glob.segs, cursor.states, name),
  }));

const collectMemberConfigFolders = (fs, order, ctx, specs, base, configNames, prune) => {
  const patterns = specs
    .filter(isPatternMember)
    .flatMap((spec) => configNames.map((name) => memberPattern(spec, base, name)));
  const found = [];
  const visited = new Set();
  for (const [start, group] of groupByBase(patterns)) {
    if (!fs.isDirectory(start)) continue;
    if (visited.has(start)) continue;
    visited.add(start);
    const queue = [{ dir: start, cursors: statesAt(group, start) }];
    for (let at = 0; at < queue.length; at += 1) {
      const item = queue[at];
      for (const entry of openDirectory(fs, order, ctx, item.dir)) {
        const path = join(item.dir, entry.name);
        const cursors = stepCursors(item.cursors, entry.name);
        if (entry.dir) {
          if (baseIgnore(ctx.collector)(path, entry.name)) continue;
          if (prune(path, entry.name, { alive: stillAlive(cursors) })) continue;
          if (visited.has(path)) continue;
          visited.add(path);
          queue.push({ dir: path, cursors });
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

const memberSpecsOf = (fs, root) => {
  const denoConfig = fs.readJSON(join(root, "deno.json"));
  return {
    deno: denoConfig.workspace.map(String),
    npm: npmMemberSpecs(fs, root),
    vendorFolder: denoConfig.vendor === true ? join(root, "vendor") : null,
  };
};

const prefixesOf = (fs, root) => {
  const specs = memberSpecsOf(fs, root);
  const out = [];
  for (const [list, names] of [
    [specs.deno, DENO_MEMBER_CONFIGS],
    [specs.npm, NPM_MEMBER_CONFIGS],
  ])
    for (const spec of list.filter(isPatternMember))
      for (const name of names) out.push(walkRootOf(memberPattern(spec, root, name)));
  return [...new Set(out)];
};

const NAME_ONLY = /^[^/*?]+$/;

const excludeMatcher = (fs, root, semantics) => {
  const raw = fs.readJSON(join(root, "deno.json")).exclude;
  const entries = Array.isArray(raw) ? raw.map(String) : [];
  const literal = entries.map((spec) => parsePattern(spec, root));
  const named = entries.filter((spec) => NAME_ONLY.test(spec));
  return (path) =>
    literal.some((pattern) => matches(pattern, path)) ||
    (semantics === "byName" &&
      under(path, root) &&
      path.length > root.length &&
      path.slice(root.length + 1).split("/").some((seg) => named.includes(seg)));
};

const expandGlobMembers = (fs, order, ctx, root, prune) => {
  const specs = memberSpecsOf(fs, root);
  ctx.collector = { vendorFolder: specs.vendorFolder };
  const found = [
    ...collectMemberConfigFolders(fs, order, ctx, specs.deno, root, DENO_MEMBER_CONFIGS, prune),
    ...collectMemberConfigFolders(fs, order, ctx, specs.npm, root, NPM_MEMBER_CONFIGS, prune),
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

const contextOf = () => ({
  opendir: 0,
  trace: [],
  phases: [],
  opens: { T0: 0, T1: 0, T2: 0, T3: 0 },
  phase: "T0",
  files: new Set(),
  collector: { vendorFolder: null },
});

const pruneFor = (fs, root, variant, ignored) =>
  pruneChain(variant.mechanisms, {
    fs,
    root,
    ignored,
    prefixes: prefixesOf(fs, root),
    excluded: excludeMatcher(fs, root, variant.excludeSemantics),
  });

export const denoModel = (fs, entryFile, corpus, order, variant, ignored) => {
  const root = findWorkspaceRoot(fs, dirname(entryFile));
  const ctx = contextOf();
  const globMembers = expandGlobMembers(
    fs,
    order,
    ctx,
    root,
    pruneFor(fs, root, variant, ignored)
  );
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

export const expandOnly = (fs, root, order, variant, ignored) => {
  const ctx = contextOf();
  const members = expandGlobMembers(fs, order, ctx, root, pruneFor(fs, root, variant, ignored));
  return { members, opendir: ctx.opendir, trace: ctx.trace };
};

const variant = (name, spec) =>
  Object.freeze({
    name,
    mechanisms: Object.freeze(spec.mechanisms ?? []),
    memoised: spec.memoised ?? false,
    excludeSemantics: spec.excludeSemantics ?? "literal",
    what: spec.what,
  });

export const BASE = variant("deno", { what: "unmodified: node_modules, .git and one vendor path" });

export const CANDIDATES = Object.freeze([
  BASE,
  variant("M1", { mechanisms: ["M1"], what: "walk_workspace's name list, applied here too" }),
  variant("M2", { mechanisms: ["M2"], what: "the version-control ignore set" }),
  variant("M3", { mechanisms: ["M3"], what: "the glob's literal prefix" }),
  variant("M5", { mechanisms: ["M5"], what: "the glob itself, at every depth" }),
  variant("M4", { memoised: true, what: "one expansion per request instead of one per load" }),
  variant("M1+M2", { mechanisms: ["M1", "M2"], what: "both name sources" }),
  variant("M3+M5", { mechanisms: ["M3", "M5"], what: "prefix and pattern bounds together" }),
  variant("M5+M4", { mechanisms: ["M5"], memoised: true, what: "the pattern bound, computed once" }),
  variant("M5+E1", {
    mechanisms: ["M5", "E1"],
    what: "the pattern bound plus the root exclude as deno spells it today",
  }),
  variant("M5+E2", {
    mechanisms: ["M5", "E2"],
    excludeSemantics: "byName",
    what: "the pattern bound plus the root exclude with bare entries matched at any depth",
  }),
  variant("M5+M2", { mechanisms: ["M5", "M2"], what: "the pattern bound plus version control" }),
  variant("E1", { mechanisms: ["E1"], what: "the root exclude alone, as deno spells it today" }),
  variant("E2", {
    mechanisms: ["E2"],
    excludeSemantics: "byName",
    what: "the root exclude alone, bare entries matched at any depth",
  }),
  variant("M1+M2+M5+M4", {
    mechanisms: ["M1", "M2", "M5"],
    memoised: true,
    what: "everything at once",
  }),
]);
