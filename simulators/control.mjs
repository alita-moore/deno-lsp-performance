const builder = () => {
  const nodes = new Map();
  const dir = (path) => {
    if (nodes.has(path)) return path;
    nodes.set(path, { children: [] });
    const cut = path.lastIndexOf("/");
    if (cut > 0) {
      const parent = dir(path.slice(0, cut));
      nodes.get(parent).children.push(path.slice(cut + 1));
    }
    return path;
  };
  const file = (parent, name, content) => {
    dir(parent);
    const path = `${parent}/${name}`;
    nodes.set(path, { content });
    nodes.get(parent).children.push(name);
    return path;
  };
  return { nodes, dir, file };
};

const ROOT = "/repo";
const MEMBERS = Object.freeze(["alpha", "beta"]);

const noiseTree = (t, base, count) => {
  t.dir(base);
  for (let i = 0; i < count; i += 1) t.file(`${base}/pkg${i}/lib`, "module.py", "");
  return base;
};

const skeleton = () => {
  const t = builder();
  t.dir(ROOT);
  t.file(
    ROOT,
    "package.json",
    JSON.stringify({ name: "sample-monorepo", private: true, workspaces: ["packages/*"] })
  );
  t.file(ROOT, "deno.json", JSON.stringify({ workspace: ["./packages/alpha", "./packages/beta"] }));
  for (const member of MEMBERS) {
    const dir = t.dir(`${ROOT}/packages/${member}`);
    t.file(dir, "package.json", JSON.stringify({ name: `@sample/${member}`, version: "0.0.1" }));
    t.file(dir, "deno.json", JSON.stringify({ name: `@sample/${member}`, exports: "./src/index.ts" }));
    t.file(`${dir}/src`, "index.ts", "export const x = 1;\n");
  }
  return t;
};

const repoOf = (t) => ({
  nodes: t.nodes,
  root: ROOT,
  entryFile: `${ROOT}/packages/alpha/src/index.ts`,
});

export const sampleRepo = (noise) => {
  const t = skeleton();
  for (const member of MEMBERS) {
    noiseTree(t, `${ROOT}/packages/${member}/.venv`, noise);
    noiseTree(t, `${ROOT}/packages/${member}/dist`, noise);
  }
  t.file(`${ROOT}/packages/alpha/node_modules/control/lib`, "index.js", "");
  noiseTree(t, `${ROOT}/.venv-at-root`, 1);
  return repoOf(t);
};

export const POSITIONS = Object.freeze({
  "inside-member": `${ROOT}/packages/alpha/.venv`,
  "at-root": `${ROOT}/.venv`,
});

export const positionControlRepo = (dirs, position) => {
  const base = POSITIONS[position];
  if (base === undefined) throw new Error(`unknown_position:${position}`);
  const t = skeleton();
  noiseTree(t, base, dirs);
  return { ...repoOf(t), tree: base, treeDirs: dirs * 2 + 1 };
};

export const opensInto = (result, phase, needle) =>
  result.trace.filter((dir, i) => result.phases[i] === phase && dir.includes(needle)).length;
