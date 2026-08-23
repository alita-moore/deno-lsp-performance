import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

const write = (root, rel, text) => {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
};

const IMPORTER = 'import { marker } from "SPECIFIER";\nexport const probe = marker;\n';
const ORPHAN_USER = "export const use = orphanMar\n";

export const CASES = Object.freeze([
  {
    name: "orphan-in-ignored",
    question: "a source file inside a gitignored directory that nothing imports",
    probe: "completion",
    files: {
      "app/dist/orphan.ts": 'export const orphanMarker: "orphan" = "orphan";\n',
      "app/src/index.ts": ORPHAN_USER,
    },
    memberInclude: ["src"],
  },
  {
    name: "orphan-in-src",
    question: "control - an unimported file the member tsconfig does seed",
    probe: "completion",
    files: {
      "app/src/orphan.ts": 'export const orphanMarker: "orphan" = "orphan";\n',
      "app/src/index.ts": ORPHAN_USER,
    },
    memberInclude: ["src"],
  },
  {
    name: "imported-from-ignored",
    question: "the same file, when an included file imports it",
    probe: "type",
    files: {
      "app/dist/gen.ts": 'export const marker: "recovered" = "recovered";\n',
      "app/src/index.ts": IMPORTER.replace("SPECIFIER", "../dist/gen.ts"),
    },
    memberInclude: ["src"],
  },
  {
    name: "generated-js-imported",
    question: "generated JavaScript in dist that an included file imports",
    probe: "type",
    files: {
      "app/dist/gen.js": 'export const marker = "recovered";\n',
      "app/dist/gen.d.ts": 'export declare const marker: "recovered";\n',
      "app/src/index.ts": IMPORTER.replace("SPECIFIER", "../dist/gen.js"),
    },
    memberInclude: ["src"],
  },
  {
    name: "include-names-untracked",
    question: "a tsconfig whose include explicitly names the untracked directory",
    probe: "completion",
    files: {
      "app/dist/orphan.ts": 'export const orphanMarker: "orphan" = "orphan";\n',
      "app/src/index.ts": ORPHAN_USER,
    },
    memberInclude: ["src", "dist"],
  },
]);

export const ARMS = Object.freeze([
  { key: "roots-all", rootExclude: [], what: "the untracked directory is in the root set" },
  {
    key: "roots-pruned",
    rootExclude: ["**/dist"],
    what: "the untracked directory is not in the root set",
  },
]);

export const buildCase = (work, kase, arm) => {
  const root = join(work, `${kase.name}--${arm.key}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  write(root, "deno.json", JSON.stringify({ workspace: ["./app"] }, null, 2));
  write(root, ".gitignore", "dist/\nnode_modules/\n");
  write(
    root,
    "tsconfig.json",
    JSON.stringify(
      {
        compilerOptions: { composite: true },
        exclude: arm.rootExclude,
        references: [{ path: "./app" }],
      },
      null,
      2
    )
  );
  write(root, "app/deno.json", JSON.stringify({ name: "@probe/app", exports: "./src/index.ts" }, null, 2));
  write(
    root,
    "app/tsconfig.json",
    JSON.stringify({ compilerOptions: { composite: true }, include: kase.memberInclude }, null, 2)
  );
  for (const [rel, text] of Object.entries(kase.files)) write(root, rel, text);
  return { root, entry: join(root, "app/src/index.ts") };
};
