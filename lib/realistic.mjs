const mulberry = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const UNTRACKED = Object.freeze([
  "node_modules",
  ".venv",
  "dist",
  "build",
  "coverage",
  ".next",
  "__pycache__",
  "target",
  ".cache",
]);

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

const vendorTree = (t, root, name, packages, depthPer) => {
  const base = t.dir(`${root}/${name}`);
  for (let i = 0; i < packages; i += 1) {
    let here = t.dir(`${base}/dep${i}`);
    for (let d = 0; d < depthPer; d += 1) here = t.dir(`${here}/lib${d}`);
    t.file(here, "index.js", "module.exports = {};\n");
    t.file(`${base}/dep${i}`, "package.json", JSON.stringify({ name: `dep${i}` }));
  }
  return base;
};

export const realisticMonorepo = (spec) => {
  const rng = mulberry(spec.seed ?? 1);
  const root = "/repo";
  const t = builder();
  t.dir(root);

  const members = [];
  const tracked = [];
  const sources = [];

  for (let p = 0; p < spec.packages; p += 1) {
    const name = `pkg${p}`;
    const pkg = t.dir(`${root}/packages/${name}`);
    members.push(`./packages/${name}`);
    tracked.push(
      t.file(pkg, "deno.json", JSON.stringify({ name: `@m/${name}`, exports: "./src/index.ts" }))
    );
    if (spec.npmWorkspaces)
      tracked.push(
        t.file(pkg, "package.json", JSON.stringify({ name: `@m/${name}`, version: "0.0.1" }))
      );
    tracked.push(t.file(pkg, "README.md", `# ${name}\n`));
    if (spec.tsconfig === "typical") {
      tracked.push(
        t.file(
          pkg,
          "tsconfig.json",
          JSON.stringify({
            compilerOptions: { composite: true },
            include: ["src"],
            exclude: ["node_modules", "dist"],
          })
        )
      );
    }
    const src = t.dir(`${pkg}/src`);
    const local = [];
    for (let f = 0; f < spec.filesPerPackage; f += 1) {
      const depth = Math.floor(rng() * (spec.depth ?? 3));
      let here = src;
      for (let d = 0; d < depth; d += 1) here = t.dir(`${here}/mod${d}`);
      local.push(t.file(here, `unit${f}.ts`, "export const v = 1;\n"));
    }
    const index = t.file(src, "index.ts", local.map((_, i) => `export * from "./unit${i}.js";\n`).join(""));
    tracked.push(index, ...local);
    sources.push(...local, index);
    const tests = t.dir(`${pkg}/__test__`);
    tracked.push(t.file(tests, "index.test.ts", `import "../src/index.js";\n`));
    if (spec.perPackageVendor > 0) vendorTree(t, pkg, "node_modules", spec.perPackageVendor, 2);
    for (const tree of spec.memberTrees ?? [])
      vendorTree(t, pkg, tree.name, tree.packages, tree.depth);
    if (spec.perPackageDist) {
      const dist = t.dir(`${pkg}/dist`);
      for (let f = 0; f < spec.filesPerPackage; f += 1) t.file(dist, `unit${f}.js`, "x\n");
    }
  }

  tracked.push(t.file(root, "deno.json", JSON.stringify({ workspace: members })));
  if (spec.npmWorkspaces)
    tracked.push(
      t.file(
        root,
        "package.json",
        JSON.stringify({ name: "@m/root", private: true, workspaces: ["packages/*"] })
      )
    );
  if (spec.tsconfig === "typical") {
    tracked.push(
      t.file(
        root,
        "tsconfig.json",
        JSON.stringify({ references: members.map((m) => ({ path: m })) })
      )
    );
  }
  tracked.push(t.file(root, ".gitignore", UNTRACKED.map((u) => `${u}/`).join("\n")));

  if (spec.rootVendor > 0) vendorTree(t, root, "node_modules", spec.rootVendor, spec.vendorDepth ?? 2);
  for (const extra of spec.extraTrees ?? [])
    vendorTree(t, root, extra.name, extra.packages, extra.depth);

  const entryFile = sources[Math.floor(rng() * sources.length)];
  const home = entryFile.slice(0, entryFile.lastIndexOf("/"));
  const imports = [];
  for (let i = 0; i < (spec.importsPerEntry ?? 4); i += 1) {
    const target = sources[Math.floor(rng() * sources.length)];
    if (target !== entryFile) imports.push(target);
  }

  return Object.freeze({
    nodes: t.nodes,
    root,
    tracked,
    sources,
    members,
    entryFile,
    home,
    imports: Object.freeze(imports),
  });
};

export const countDirs = (nodes) => {
  let n = 0;
  for (const node of nodes.values()) if (node.children !== undefined) n += 1;
  return n;
};

export const PRESETS = Object.freeze({
  small: { packages: 5, filesPerPackage: 12, depth: 2, rootVendor: 120, perPackageVendor: 0, tsconfig: "typical", npmWorkspaces: true },
  medium: { packages: 20, filesPerPackage: 25, depth: 3, rootVendor: 600, perPackageVendor: 0, tsconfig: "typical", perPackageDist: true, npmWorkspaces: true, memberTrees: [{ name: ".venv", packages: 40, depth: 2 }] },
  large: { packages: 60, filesPerPackage: 40, depth: 4, rootVendor: 1000, perPackageVendor: 20, vendorDepth: 3, tsconfig: "typical", npmWorkspaces: true, memberTrees: [{ name: ".venv", packages: 60, depth: 3 }] },
  reported: { packages: 53, filesPerPackage: 45, depth: 4, rootVendor: 2000, perPackageVendor: 8, vendorDepth: 2, tsconfig: "typical", npmWorkspaces: true, memberTrees: [{ name: ".venv", packages: 120, depth: 3 }, { name: ".cache", packages: 20, depth: 2 }] },
});
