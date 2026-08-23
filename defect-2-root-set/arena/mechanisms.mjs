export const MECHANISMS = Object.freeze({
  R1: {
    title: "honour the version-control ignore set",
    site: "cli/util/fs.rs:135 collect_specifiers, .use_gitignore() on the builder chain",
    functions: 1,
    input: 0,
    visible: 2,
  },
  R2: {
    title: "pass the scope's real vendor folder instead of None",
    site: "cli/lsp/compiler_options.rs:102 vendor_folder",
    functions: 1,
    input: 0,
    visible: 1,
  },
  R3: {
    title: "bound descent by whether an include pattern can still match below",
    site: "libs/config/glob/collector.rs:177 collect_file_patterns",
    functions: 1,
    input: 0,
    visible: 0,
  },
  R4: {
    title: "share the traversal across overlapping FilePatterns bases",
    site: "cli/lsp/compiler_options.rs:91 from_inner, ts_config_roots_cache",
    functions: 1,
    input: 0,
    visible: 0,
  },
  X1: {
    title: "the tsconfig exclude, today's literal-path semantics",
    site: "already implemented",
    functions: 0,
    input: 0,
    visible: 0,
  },
  X2: {
    title: "the tsconfig exclude, bare entries matched at any depth below the config",
    site: "libs/config/glob/mod.rs PathOrPattern::from_relative",
    functions: 1,
    input: 0,
    visible: 2,
  },
});

const variant = (name, mechanisms, what) =>
  Object.freeze({ name, mechanisms: Object.freeze(mechanisms), what });

export const BASE = variant("deno", [], "unmodified: node_modules and .git only, vendor_folder None");

export const CANDIDATES = Object.freeze([
  BASE,
  variant("R1", ["R1"], "the version-control ignore set"),
  variant("R2", ["R2"], "a real vendor folder"),
  variant("R3", ["R3"], "the include pattern, at every depth"),
  variant("R4", ["R4"], "one traversal shared across overlapping bases"),
  variant("X1", ["X1"], "the tsconfig exclude as deno spells it today"),
  variant("X2", ["X2"], "the tsconfig exclude, bare entries at any depth"),
  variant("R1+R4", ["R1", "R4"], "the ignore set plus the shared traversal"),
  variant("R3+R4", ["R3", "R4"], "the pattern bound plus the shared traversal"),
  variant("R1+R3+R4", ["R1", "R3", "R4"], "everything that needs no configuration"),
]);

export const invasivenessOf = (keys) => {
  let total = 0;
  for (const key of keys) {
    const mechanism = MECHANISMS[key];
    if (mechanism === undefined) throw new Error(`unknown_mechanism:${key}`);
    total += mechanism.functions + mechanism.input + mechanism.visible;
  }
  return total;
};

export const sitesOf = (keys) => [...new Set(keys.map((key) => MECHANISMS[key].site))].join(" + ");
