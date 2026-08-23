import { join, dirname, resolve } from "node:path";
import { findWorkspaceRoot, workspaceMembers } from "../../lib/config.mjs";

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

export const under = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);

const matches = (pattern, path) =>
  pattern.glob === null ? under(path, pattern.path) : globMatches(pattern.glob.segs, path);

const walkRootOf = (pattern) =>
  pattern.glob === null ? pattern.path : literalPrefix(pattern.glob.text);

const openDirectory = (fs, order, ctx, dir) => {
  if (ctx.shared !== null && ctx.shared.has(dir)) return order(ctx.shared.get(dir), dir);
  ctx.opendir += 1;
  ctx.opens[ctx.phase] += 1;
  ctx.trace.push(dir);
  ctx.phases.push(ctx.phase);
  const entries = fs.readdir(dir);
  if (ctx.shared !== null) ctx.shared.set(dir, entries);
  return order(entries, dir);
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
      fs, order, ctx, denoConfig.workspace.map(String), root, DENO_MEMBER_CONFIGS, vendorFolder
    ),
    ...collectMemberConfigFolders(
      fs, order, ctx, npmMemberSpecs(fs, root), root, NPM_MEMBER_CONFIGS, vendorFolder
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

const NAME_ONLY = /^[^/*?]+$/;

const excludeSpecsOf = (cfg) => (Array.isArray(cfg.exclude) ? cfg.exclude.map(String) : []);

const collectSpecifiers = (fs, order, ctx, base, cfg, plan) => {
  const includeSpecs = includeSpecsOf(cfg, base);
  const includes = includeSpecs.map((spec) => parsePattern(spec, base));
  const literalIncludes = (Array.isArray(cfg.include) ? cfg.include.map(String) : [])
    .filter((spec) => !WILDCARD.test(spec))
    .map((spec) => resolve(base, spec.replace(/\/+$/, "")));
  const excludeSpecs = excludeSpecsOf(cfg);
  const excludes = excludeSpecs.map((spec) => parsePattern(spec, base));
  const namedExcludes = excludeSpecs.filter((spec) => NAME_ONLY.test(spec));
  const included = (path) => includes.some((pattern) => matches(pattern, path));
  const excluded = (path) =>
    excludes.some((pattern) => matches(pattern, path)) ||
    (plan.excludeByName &&
      under(path, base) &&
      path.length > base.length &&
      path.slice(base.length + 1).split("/").some((seg) => namedExcludes.includes(seg)));
  const overrideFor = (path) =>
    literalIncludes.filter((held) => under(path, held)).sort((a, b) => b.length - a.length)[0];
  const vcsPruned = (path) => {
    if (plan.vcs === null) return false;
    const override = overrideFor(path);
    return plan.vcs.ignoredBelow(override === undefined ? plan.vcs.root : override, path);
  };
  const vendorPruned = (path) => plan.vendorFolder !== null && path === plan.vendorFolder;
  const walk = (dir, cursors) => {
    for (const entry of openDirectory(fs, order, ctx, dir)) {
      const path = join(dir, entry.name);
      if (excluded(path)) continue;
      if (entry.dir) {
        if (entry.name === SPECIFIER_SKIP) continue;
        if (vcsPruned(path)) continue;
        if (vendorPruned(path)) continue;
        const next = cursors.map((cursor) =>
          cursor === null
            ? null
            : { segs: cursor.segs, states: stepStates(cursor.segs, cursor.states, entry.name) }
        );
        if (plan.patternBound && !aliveIn(next)) continue;
        walk(path, next);
        continue;
      }
      if (SCRIPT_EXTENSION.test(entry.name) && included(path)) {
        ctx.files.add(path);
        ctx.rootSet.add(path);
      }
    }
  };
  for (const pattern of includes) {
    const start = walkRootOf(pattern);
    if (excluded(start)) continue;
    if (vcsPruned(start)) continue;
    if (fs.isDirectory(start)) {
      walk(start, cursorsAt(includes, start));
      continue;
    }
    if (fs.exists(start) && SCRIPT_EXTENSION.test(start)) {
      ctx.files.add(start);
      ctx.rootSet.add(start);
    }
  }
};

const cursorsAt = (includes, path) =>
  includes.map((pattern) =>
    pattern.glob === null
      ? null
      : {
          segs: pattern.glob.segs,
          states: segmentsOf(path).reduce(
            (states, name) => stepStates(pattern.glob.segs, states, name),
            new Set([0])
          ),
        }
  );

const aliveIn = (cursors) =>
  cursors.some((cursor) =>
    cursor === null ? true : [...cursor.states].some((i) => i < cursor.segs.length)
  );

const collectTsconfigAt = (fs, order, ctx, base, plan) => {
  const config = join(base, "tsconfig.json");
  if (!fs.exists(config)) return;
  collectSpecifiers(fs, order, ctx, base, fs.readJSON(config), plan);
};

const planFor = (variant, root, vcs) => ({
  vcs: variant.mechanisms.includes("R1") ? vcs : null,
  vendorFolder: variant.mechanisms.includes("R2") ? join(root, "vendor") : null,
  patternBound: variant.mechanisms.includes("R3"),
  excludeByName: variant.mechanisms.includes("X2"),
});

export const denoModel = (fs, entryFile, corpus, order, variant, vcs) => {
  const root = findWorkspaceRoot(fs, dirname(entryFile));
  const ctx = {
    opendir: 0,
    trace: [],
    phases: [],
    opens: { T0: 0, T1: 0, T2: 0, T3: 0 },
    phase: "T0",
    files: new Set(),
    rootSet: new Set(),
    shared: null,
  };
  const plan = planFor(variant, root, vcs);

  const globMembers = expandGlobMembers(fs, order, ctx, root);
  ctx.phase = "T1";
  walkWorkspace(fs, order, ctx, root);
  if (variant.mechanisms.includes("R4")) ctx.shared = new Map();
  ctx.phase = "T2";
  collectTsconfigAt(fs, order, ctx, root, plan);
  ctx.phase = "T3";
  for (const member of workspaceMembers(fs, root)) collectTsconfigAt(fs, order, ctx, member, plan);
  ctx.shared = null;

  return {
    files: ctx.files,
    rootSet: ctx.rootSet,
    opendir: ctx.opendir,
    trace: ctx.trace,
    phases: ctx.phases,
    opens: ctx.opens,
    globMembers,
    root,
  };
};
