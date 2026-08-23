import { realisticMonorepo, PRESETS } from "../../lib/realistic.mjs";

const rootDenoConfig = (repo, extra) => {
  const node = repo.nodes.get(`${repo.root}/deno.json`);
  if (node === undefined) throw new Error("condition_needs_a_root_deno_json");
  node.content = JSON.stringify({ ...JSON.parse(node.content), ...extra });
};

export const CONDITIONS = Object.freeze([
  {
    key: "A",
    label: "as generated - members are a glob, nothing in any configuration mentions the vendor trees",
    specOf: (spec) => spec,
    finish: () => {},
    expandsMembers: true,
  },
  {
    key: "X",
    label: "the user wrote it down - root deno.json carries exclude: [\".venv\", \".cache\"]",
    specOf: (spec) => spec,
    finish: (repo) => rootDenoConfig(repo, { exclude: [".venv", ".cache"] }),
    expandsMembers: true,
  },
  {
    key: "P",
    label: "the repository-side mitigation - no glob members, package.json workspaces removed",
    specOf: (spec) => ({ ...spec, npmWorkspaces: false }),
    finish: () => {},
    expandsMembers: false,
  },
]);

export const buildRepo = (spec, condition, seed) => {
  const repo = realisticMonorepo(condition.specOf({ ...spec, seed }));
  condition.finish(repo, spec);
  return repo;
};

export const PRESET_LIST = Object.freeze(
  Object.entries(PRESETS).map(([name, spec]) => ({ name, spec }))
);

const builder = () => {
  const nodes = new Map();
  const dir = (path) => {
    if (nodes.has(path)) return path;
    nodes.set(path, { children: [] });
    const cut = path.lastIndexOf("/");
    if (cut > 0) nodes.get(dir(path.slice(0, cut))).children.push(path.slice(cut + 1));
    return path;
  };
  const file = (parent, name, content) => {
    dir(parent);
    nodes.set(`${parent}/${name}`, { content });
    nodes.get(parent).children.push(name);
  };
  return { nodes, dir, file };
};

const noiseTree = (t, at, packages, depth) => {
  for (let i = 0; i < packages; i += 1) {
    let here = t.dir(`${at}/dep${i}`);
    for (let d = 0; d < depth; d += 1) here = t.dir(`${here}/lib${d}`);
    t.file(here, "index.js", "x\n");
    t.file(`${at}/dep${i}`, "package.json", JSON.stringify({ name: `dep${i}` }));
  }
};

const adversarial = (spec) => {
  const root = "/repo";
  const t = builder();
  t.dir(root);
  t.file(root, "deno.json", JSON.stringify({ workspace: [], exclude: spec.exclude ?? [] }));
  t.file(root, "package.json", JSON.stringify({ workspaces: spec.workspaces }));
  t.file(root, ".gitignore", spec.ignore.map((name) => `${name}/`).join("\n"));
  for (const member of spec.members) {
    const dir = t.dir(`${root}/${member}`);
    t.file(dir, "package.json", JSON.stringify({ name: member.split("/").at(-1) }));
    t.file(t.dir(`${dir}/src`), "index.ts", "export const v = 1;\n");
  }
  for (const noise of spec.noise) noiseTree(t, t.dir(`${root}/${noise.at}`), noise.packages, 2);
  return Object.freeze({
    name: spec.name,
    question: spec.question,
    nodes: t.nodes,
    root,
    workspaces: Object.freeze(spec.workspaces),
    exclude: Object.freeze(spec.exclude ?? []),
    trueMembers: Object.freeze(spec.members.map((member) => `${root}/${member}`).sort()),
  });
};

export const ADVERSARIAL = Object.freeze([
  adversarial({
    name: "vendor-members",
    question: "members live under a directory walk_workspace hardcodes as skippable",
    workspaces: ["vendor/*"],
    members: ["vendor/alpha", "vendor/beta", "vendor/gamma"],
    ignore: [".venv", "node_modules", "dist"],
    noise: [{ at: "vendor/alpha/.venv", packages: 200 }],
  }),
  adversarial({
    name: "coverage-members",
    question: "same, for the other name on that list",
    workspaces: ["coverage/*"],
    members: ["coverage/alpha", "coverage/beta"],
    ignore: [".venv", "node_modules"],
    noise: [{ at: "coverage/alpha/.venv", packages: 200 }],
  }),
  adversarial({
    name: "ignored-member",
    question: "one member sits inside a directory version control ignores",
    workspaces: ["packages/*"],
    members: ["packages/alpha", "packages/beta", "packages/generated"],
    ignore: ["generated", ".venv", "node_modules"],
    noise: [{ at: "packages/alpha/.venv", packages: 200 }],
  }),
  adversarial({
    name: "dist-members",
    question: "every member sits inside a directory version control ignores",
    workspaces: ["dist/*"],
    members: ["dist/alpha", "dist/beta"],
    ignore: ["dist", ".venv", "node_modules"],
    noise: [{ at: "dist/alpha/.venv", packages: 200 }],
  }),
  adversarial({
    name: "vendor-named-member",
    question: "a member whose own name is on walk_workspace's skip list",
    workspaces: ["packages/*"],
    members: ["packages/alpha", "packages/vendor", "packages/coverage"],
    ignore: [".venv", "node_modules"],
    noise: [{ at: "packages/alpha/.venv", packages: 200 }],
  }),
  adversarial({
    name: "excluded-member",
    question: "the user excluded a directory that contains a member",
    workspaces: ["packages/*"],
    members: ["packages/alpha", "packages/generated"],
    exclude: ["generated"],
    ignore: [".venv", "node_modules"],
    noise: [{ at: "packages/alpha/.venv", packages: 200 }],
  }),
  adversarial({
    name: "no-literal-prefix",
    question: "a member glob with no useful prefix and an unbounded head",
    workspaces: ["**/pkg-*"],
    members: ["apps/pkg-a", "libs/deep/pkg-b"],
    exclude: [".venv"],
    ignore: [".venv", "node_modules"],
    noise: [{ at: ".venv", packages: 200 }, { at: "apps/pkg-a/.venv", packages: 200 }],
  }),
  adversarial({
    name: "nested-glob",
    question: "two wildcards, a bounded tail, vendor mass inside a matched member",
    workspaces: ["apps/*/packages/*"],
    members: ["apps/one/packages/alpha", "apps/two/packages/beta"],
    ignore: [".venv", "node_modules"],
    noise: [{ at: "apps/one/packages/alpha/.venv", packages: 200 }],
  }),
  adversarial({
    name: "member-under-node-modules",
    question: "a member deno already cannot find, as a control on the base itself",
    workspaces: ["node_modules/@scope/*"],
    members: ["node_modules/@scope/alpha"],
    ignore: [".venv"],
    noise: [],
  }),
]);
