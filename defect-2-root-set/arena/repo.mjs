import { realisticMonorepo, PRESETS } from "../../lib/realistic.mjs";

const rewrite = (repo, rel, value) => {
  const node = repo.nodes.get(`${repo.root}${rel}`);
  if (node === undefined) throw new Error(`no_config_at:${rel}`);
  node.content = JSON.stringify(value(JSON.parse(node.content)));
};

const eachMemberTsconfig = (repo, value) => {
  for (const member of repo.members) rewrite(repo, `/${member.replace("./", "")}/tsconfig.json`, value);
};

export const CONDITIONS = Object.freeze([
  {
    key: "A",
    label: "as generated - root tsconfig carries references only, members exclude node_modules and dist",
    finish: () => {},
  },
  {
    key: "N",
    label: "no exclude anywhere - the shape the reproduction uses",
    finish: (repo) => {
      eachMemberTsconfig(repo, (cfg) => {
        const { exclude, ...rest } = cfg;
        return rest;
      });
    },
  },
  {
    key: "X",
    label: 'the user wrote it down - root tsconfig exclude [".venv", ".cache", "dist"], bare names',
    finish: (repo) => {
      rewrite(repo, "/tsconfig.json", (cfg) => ({ ...cfg, exclude: [".venv", ".cache", "dist"] }));
    },
  },
  {
    key: "I",
    label: 'the user narrowed include - root tsconfig include ["packages/*/src"]',
    finish: (repo) => {
      rewrite(repo, "/tsconfig.json", (cfg) => ({ ...cfg, include: ["packages/*/src"] }));
    },
  },
  {
    key: "F",
    label: 'the repository-side mitigation - root tsconfig files: []',
    finish: (repo) => {
      rewrite(repo, "/tsconfig.json", (cfg) => ({ ...cfg, files: [] }));
    },
  },
]);

export const buildRepo = (spec, condition, seed) => {
  const repo = realisticMonorepo({ ...spec, seed });
  condition.finish(repo);
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

const noiseTree = (t, at, packages) => {
  for (let i = 0; i < packages; i += 1) {
    t.file(t.dir(`${at}/dep${i}`), "index.js", "export const dep = 1;\n");
  }
};

const adversarial = (spec) => {
  const root = "/repo";
  const t = builder();
  t.dir(root);
  t.file(root, "deno.json", JSON.stringify({ workspace: spec.members.map((m) => `./${m}`) }));
  t.file(root, ".gitignore", spec.ignore.map((name) => `${name}/`).join("\n"));
  t.file(
    root,
    "tsconfig.json",
    JSON.stringify({ references: spec.members.map((m) => ({ path: `./${m}` })) })
  );
  for (const member of spec.members) {
    const dir = t.dir(`${root}/${member}`);
    t.file(dir, "deno.json", JSON.stringify({ name: `@a/${member.split("/").at(-1)}` }));
    t.file(
      dir,
      "tsconfig.json",
      JSON.stringify(spec.memberInclude === undefined ? {} : { include: spec.memberInclude })
    );
  }
  for (const [rel, text] of Object.entries(spec.files)) {
    const cut = rel.lastIndexOf("/");
    t.file(t.dir(`${root}/${rel.slice(0, cut)}`), rel.slice(cut + 1), text);
  }
  for (const noise of spec.noise ?? []) noiseTree(t, t.dir(`${root}/${noise.at}`), noise.packages);
  return Object.freeze({
    name: spec.name,
    question: spec.question,
    nodes: t.nodes,
    root,
    entryFile: `${root}/${spec.entry}`,
    subject: `${root}/${spec.subject}`,
    mustKeep: Object.freeze((spec.mustKeep ?? []).map((rel) => `${root}/${rel}`)),
  });
};

const MARKER = 'export const marker = "recovered";\n';

export const ADVERSARIAL = Object.freeze([
  adversarial({
    name: "orphan-in-ignored",
    subject: "app/dist/orphan.ts",
    question: "a source file inside a gitignored directory that nothing imports",
    members: ["app"],
    memberInclude: ["src"],
    ignore: ["dist", "node_modules"],
    entry: "app/src/index.ts",
    files: {
      "app/src/index.ts": "export const v = 1;\n",
      "app/dist/orphan.ts": MARKER,
    },
    noise: [{ at: "app/dist/bundle", packages: 200 }],
  }),
  adversarial({
    name: "imported-from-ignored",
    subject: "app/dist/gen.ts",
    question: "the same file, when an included file imports it",
    members: ["app"],
    memberInclude: ["src"],
    ignore: ["dist", "node_modules"],
    entry: "app/src/index.ts",
    files: {
      "app/src/index.ts": 'import { marker } from "../dist/gen.ts";\nexport const v = marker;\n',
      "app/dist/gen.ts": MARKER,
    },
    mustKeep: ["app/dist/gen.ts"],
    noise: [{ at: "app/dist/bundle", packages: 200 }],
  }),
  adversarial({
    name: "generated-js-imported",
    subject: "app/dist/gen.js",
    question: "generated JavaScript in dist that an included file imports",
    members: ["app"],
    memberInclude: ["src"],
    ignore: ["dist", "node_modules"],
    entry: "app/src/index.ts",
    files: {
      "app/src/index.ts": 'import { marker } from "../dist/gen.js";\nexport const v = marker;\n',
      "app/dist/gen.js": MARKER,
    },
    mustKeep: ["app/dist/gen.js"],
    noise: [{ at: "app/dist/bundle", packages: 200 }],
  }),
  adversarial({
    name: "include-names-untracked",
    subject: "app/dist/orphan.ts",
    question: "a tsconfig whose include explicitly names the untracked directory",
    members: ["app"],
    memberInclude: ["src", "dist"],
    ignore: ["dist", "node_modules"],
    entry: "app/src/index.ts",
    files: {
      "app/src/index.ts": "export const v = 1;\n",
      "app/dist/orphan.ts": MARKER,
    },
    mustKeep: ["app/dist/orphan.ts"],
    noise: [{ at: "app/dist/bundle", packages: 200 }],
  }),
  adversarial({
    name: "member-inside-ignored",
    subject: "dist/alpha/src/index.ts",
    question: "every workspace member sits inside a directory version control ignores",
    members: ["dist/alpha", "dist/beta"],
    memberInclude: ["src"],
    ignore: ["dist", "node_modules"],
    entry: "dist/alpha/src/index.ts",
    files: {
      "dist/alpha/src/index.ts": "export const a = 1;\n",
      "dist/beta/src/index.ts": "export const b = 1;\n",
    },
    mustKeep: ["dist/alpha/src/index.ts", "dist/beta/src/index.ts"],
  }),
  adversarial({
    name: "member-no-include",
    subject: "dist/alpha/src/index.ts",
    question: "the same, when the member tsconfig names no include at all",
    members: ["dist/alpha"],
    memberInclude: undefined,
    ignore: ["dist", "node_modules"],
    entry: "dist/alpha/src/index.ts",
    files: { "dist/alpha/src/index.ts": "export const a = 1;\n" },
    mustKeep: ["dist/alpha/src/index.ts"],
  }),
  adversarial({
    name: "tracked-only",
    subject: "app/src/util.ts",
    question: "nothing untracked anywhere, as a control on every mechanism",
    members: ["app"],
    memberInclude: ["src"],
    ignore: ["node_modules"],
    entry: "app/src/index.ts",
    files: {
      "app/src/index.ts": 'import { marker } from "./util.ts";\nexport const v = marker;\n',
      "app/src/util.ts": MARKER,
    },
    mustKeep: ["app/src/index.ts", "app/src/util.ts"],
  }),
]);
