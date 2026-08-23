import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";

const SOURCES = {
  "src/index.ts": 'import { used } from "./used";\nimport { helper } from "./sub/helper";\nexport const index = used + helper;\n',
  "src/used.ts": 'export const used = 1;\n',
  "src/other.ts": 'export const other = 2;\n',
  "src/sub/helper.ts": 'import { dep } from "../../outside/dep";\nexport const helper = dep;\n',
  "outside/dep.ts": 'export const dep = 3;\n',
  "lib/extra.ts": 'export const extra = 4;\n',
  "node_modules/pkg/index.ts": 'export const pkg = 5;\n',
};

const COMPILER_OPTIONS = {
  target: "esnext",
  module: "esnext",
  moduleResolution: "bundler",
  types: [],
};

const src = (...names) => names.map((name) => `src/${name}`);

export const SEMANTICS_CASES = [
  {
    id: "include-dir",
    claim: "include selects a directory subtree",
    config: { include: ["src"] },
    expect: [...src("index.ts", "used.ts", "other.ts", "sub/helper.ts"), "outside/dep.ts"],
  },
  {
    id: "import-escapes-include",
    claim: "the import closure reaches outside every include root",
    config: { include: ["src/index.ts"] },
    expect: [...src("index.ts", "used.ts", "sub/helper.ts"), "outside/dep.ts"],
  },
  {
    id: "exclude-imported-dir",
    claim: "exclude of a directory does not drop a file imported from inside it",
    config: { include: ["src"], exclude: ["src/sub"] },
    expect: [...src("index.ts", "used.ts", "other.ts", "sub/helper.ts"), "outside/dep.ts"],
  },
  {
    id: "exclude-imported-file",
    claim: "exclude of a file does not drop it when an included file imports it",
    config: { include: ["src"], exclude: ["src/used.ts"] },
    expect: [...src("index.ts", "used.ts", "other.ts", "sub/helper.ts"), "outside/dep.ts"],
  },
  {
    id: "exclude-unimported-file",
    claim: "exclude of a file nothing imports does drop it",
    config: { include: ["src"], exclude: ["src/other.ts"] },
    expect: [...src("index.ts", "used.ts", "sub/helper.ts"), "outside/dep.ts"],
  },
  {
    id: "files-only",
    claim: "files seeds the program and nothing else is enumerated",
    config: { files: ["src/index.ts"] },
    expect: [...src("index.ts", "used.ts", "sub/helper.ts"), "outside/dep.ts"],
  },
  {
    id: "files-ignores-exclude",
    claim: "exclude does not apply to a files entry",
    config: { files: ["src/other.ts"], exclude: ["src/other.ts"] },
    expect: src("other.ts"),
  },
  {
    id: "files-with-include",
    claim: "files and include union",
    config: { files: ["lib/extra.ts"], include: ["src"] },
    expect: [...src("index.ts", "used.ts", "other.ts", "sub/helper.ts"), "outside/dep.ts", "lib/extra.ts"],
  },
  {
    id: "default-skips-node-modules",
    claim: "an absent include defaults to **/* and still skips node_modules",
    config: {},
    expect: [...src("index.ts", "used.ts", "other.ts", "sub/helper.ts"), "outside/dep.ts", "lib/extra.ts"],
  },
  {
    id: "glob-skips-node-modules",
    claim: "a glob that would match node_modules does not override the skip",
    config: { include: ["**/*"] },
    expect: [...src("index.ts", "used.ts", "other.ts", "sub/helper.ts"), "outside/dep.ts", "lib/extra.ts"],
  },
  {
    id: "literal-include-enters-node-modules",
    claim: "naming node_modules literally in include overrides the skip",
    config: { include: ["src", "node_modules"] },
    expect: [
      ...src("index.ts", "used.ts", "other.ts", "sub/helper.ts"),
      "outside/dep.ts",
      "node_modules/pkg/index.ts",
    ],
  },
];

const writeFile = (path, content) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

export const materialiseFixture = (root) => {
  rmSync(root, { recursive: true, force: true });
  return SEMANTICS_CASES.map((testCase) => {
    const dir = join(root, testCase.id);
    for (const [name, content] of Object.entries(SOURCES)) writeFile(join(dir, name), content);
    writeFile(
      join(dir, "tsconfig.json"),
      `${JSON.stringify({ compilerOptions: COMPILER_OPTIONS, ...testCase.config }, null, 2)}\n`
    );
    return {
      ...testCase,
      dir,
      entry: join(dir, "src/index.ts"),
      expect: new Set(testCase.expect.map((name) => join(dir, name))),
    };
  });
};
