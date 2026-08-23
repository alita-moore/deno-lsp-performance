import { join, dirname } from "node:path";

const COLLECTOR_SKIP = new Set(["node_modules", ".git"]);
const WALK_WORKSPACE_EXTRA = new Set(["vendor", "coverage"]);

export const under = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);

const cargoTarget = (fs, path, name) =>
  name.toLowerCase() === "target" && fs.exists(join(dirname(path), "Cargo.toml"));

export const baseIgnore = (ctx) => (path, name) =>
  COLLECTOR_SKIP.has(name.toLowerCase()) || path === ctx.vendorFolder;

const walkWorkspaceNames = (ctx) => (path, name) =>
  WALK_WORKSPACE_EXTRA.has(name.toLowerCase()) || cargoTarget(ctx.fs, path, name);

const vcsIgnored = (ctx) => (path) => ctx.ignored(path);

const outsideLiteralPrefix = (ctx) => (path) =>
  !ctx.prefixes.some((prefix) => under(path, prefix) || under(prefix, path));

const patternDead = () => (path, name, states) => !states.alive;

const excludedByConfig = (ctx) => (path) => ctx.excluded(path);

export const vcsIgnoreMatcher = (fs, root) => {
  const path = join(root, ".gitignore");
  if (!fs.exists(path)) throw new Error(`no_gitignore:${root}`);
  const names = [];
  const anchored = [];
  for (const raw of fs.readFile(path).split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (line.startsWith("!")) throw new Error(`gitignore_negation_unsupported:${line}`);
    const text = line.replace(/\/+$/, "");
    if (text.includes("*") || text.includes("?")) throw new Error(`gitignore_glob_unsupported:${line}`);
    if (text.includes("/")) anchored.push(join(root, text));
    else names.push(text);
  }
  return (candidate) =>
    under(candidate, root) &&
    candidate.length > root.length &&
    (candidate
      .slice(root.length + 1)
      .split("/")
      .some((segment) => names.includes(segment)) ||
      anchored.some((prefix) => under(candidate, prefix)));
};

export const MECHANISMS = Object.freeze({
  M1: {
    prune: walkWorkspaceNames,
    title: "extend is_ignored_dir with what walk_workspace already skips",
    site: "libs/config/glob/collector.rs:195 is_ignored_dir",
    functions: 1,
    input: 0,
    visible: 2,
  },
  M2: {
    prune: vcsIgnored,
    title: "add .use_gitignore() to the member collector's builder chain",
    site: "libs/config/workspace/discovery.rs:797 collect_member_config_folders",
    functions: 1,
    input: 0,
    visible: 2,
  },
  M3: {
    prune: outsideLiteralPrefix,
    title: "bound descent by the member glob's literal prefix",
    site: "libs/config/glob/collector.rs:177 collect_file_patterns",
    functions: 1,
    input: 0,
    visible: 0,
  },
  M5: {
    prune: patternDead,
    title: "bound descent by whether the member glob can still match below",
    site: "libs/config/glob/collector.rs:177 collect_file_patterns",
    functions: 1,
    input: 0,
    visible: 0,
  },
  E1: {
    prune: excludedByConfig,
    title: "honour the workspace root deno.json exclude, today's literal-path semantics",
    site: "libs/config/workspace/discovery.rs:792 collect_member_config_folders",
    functions: 1,
    input: 0,
    visible: 1,
  },
  E2: {
    prune: excludedByConfig,
    title: "honour the workspace root deno.json exclude, bare entries matched at any depth",
    site: "libs/config/workspace/discovery.rs:792 collect_member_config_folders",
    functions: 1,
    input: 0,
    visible: 2,
  },
});

export const MEMOISE = Object.freeze({
  M4: {
    title: "memoise the expansion across ConfigData::load calls",
    site: "cli/lsp/config.rs:2013 Inner::refresh_config_tree",
    functions: 1,
    input: 0,
    visible: 0,
  },
});

export const pruneChain = (keys, ctx) => {
  const rules = keys.map((key) => MECHANISMS[key].prune(ctx));
  return (path, name, states) => rules.some((rule) => rule(path, name, states));
};

export const invasivenessOf = (keys, memoised) => {
  let total = memoised ? MEMOISE.M4.functions + MEMOISE.M4.input + MEMOISE.M4.visible : 0;
  for (const key of keys) {
    const mechanism = MECHANISMS[key];
    if (mechanism === undefined) throw new Error(`unknown_mechanism:${key}`);
    total += mechanism.functions + mechanism.input + mechanism.visible;
  }
  return total;
};

export const sitesOf = (keys, memoised) =>
  [
    ...new Set([
      ...keys.map((key) => MECHANISMS[key].site),
      ...(memoised ? [MEMOISE.M4.site] : []),
    ]),
  ].join(" + ");
