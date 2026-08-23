import { readFileSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { denoResolve } from "./deno.mjs";
import { tscResolve, findConfig } from "./typescript.mjs";
import { materialiseFixture } from "./fixture.mjs";
import { sampleRepo, positionControlRepo, opensInto } from "./control.mjs";
import { realFS, memFS } from "../lib/fs.mjs";
import { everythingCorpus } from "../lib/corpus.mjs";
import { realisticMonorepo, countDirs, PRESETS } from "../lib/realistic.mjs";

const MEASURED = {
  "A01-sibling": [809, 802], "A02-in-src": [1210, 1203], "A03-deep": [1219, 1203],
  "A04-dotcache": [809, 802], "A05-vendor": [408, 408], "A06-target": [809, 809],
  "A07-build": [809, 809], "A08-coverage": [408, 408], "A09-next": [809, 802],
  "A10-pycache": [809, 802], "B01-nm-sibling": [7, 0], "B02-nm-in-src": [7, 0],
  "B03-nm-deep": [13, 0], "B04-nm-nested": [7, 0], "C01-include-nm": [408, 401],
  "C02-include-nm-only": [407, 401], "C03-include-venv": [1210, 1203],
  "C04-include-star": [1211, 1203], "C05-include-nm-root": [4, 0],
  "C06-no-exclude-at-all": [809, 802], "C07-empty-exclude": [809, 802],
  "C08-exclude-src": [808, 802], "D01-pkg-plain": [809, 802], "D02-pkg-glob": [809, 802],
  "D03-pkg-slash": [809, 802], "D04-pkg-starstar": [809, 802], "D05-pkg-abs": [809, 802],
  "D06-root-plain": [408, 401], "D07-root-glob": [408, 401], "D08-root-starstar": [409, 402],
  "D09-root-bare": [809, 802], "E01-no-pkg-tsconfig": [808, 802], "E02-files-list": [808, 802],
  "E03-no-composite": [809, 802], "E04-no-references": [809, 802], "E05-noise-at-root": [809, 802],
  "E06-noise-root-nm": [7, 0], "F01-packages": [809, 802], "F02-packages": [814, 802],
  "F05-packages": [829, 802], "F10-packages": [854, 802], "F25-packages": [929, 802],
  "F50-packages": [1054, 802], "G01-packages-nm": [7, 0], "G10-packages-nm": [52, 0],
  "G50-packages-nm": [252, 0],
};

const MEASURED_EXPANSION = Object.freeze({
  sampleNoise: 1500,
  sampleStack: 12009,
  sampleTotal: 21192,
  controlDirs: 800,
});

const POSITION_ARMS = Object.freeze({
  "inside-member": { expansion: 1601, all: 2587 },
  "at-root": { expansion: 0, all: 1 },
});

const PRESET_SEED = 1;

const ARTIFACT = /\.(?:js|d\.ts|tsbuildinfo)$/;

const MATRIX = process.argv[2] ?? process.env.MATRIX_BUILD_ROOT ?? "/var/tmp/matrix";
const CASES = process.argv[3] ?? join(dirname(process.argv[1]), "../defect-2-root-set/matrix/configs");
const WORK = process.env.CALIBRATE_WORK ?? join(tmpdir(), "deno-file-resolution-calibrate");

const FIXTURE_ROOT = join(WORK, "fixture");
const TSC_OUT = join(WORK, "tsc-out");

const RFS = realFS();
const identityOrder = (entries) => entries;

const pad = (value, width) => String(value).padStart(width);
const cell = (value, width) => String(value).padEnd(width);

const caseEntry = (root, id) => {
  const spec = JSON.parse(readFileSync(join(CASES, id, "case.json"), "utf8"));
  const packages = spec.packages ?? 1;
  return { spec, entry: join(root, packages > 1 ? "app0" : "app", "src/index.ts") };
};

const listFiles = (config, root) => {
  const run = spawnSync(
    "npx",
    [
      "tsc", "--listFiles", "-p", config,
      "--outDir", join(TSC_OUT, "js"),
      "--declarationDir", join(TSC_OUT, "dts"),
      "--tsBuildInfoFile", join(TSC_OUT, "build.tsbuildinfo"),
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 }
  );
  return new Set(
    `${run.stdout}`
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith(`${root}/`) && !line.includes("/typescript/lib/"))
  );
};

const leafOf = (tree) => tree.split("/").at(-1);

const harnessOpensInto = (trace, tree) =>
  tree === "" ? 0 : trace.filter((dir) => dir.includes(leafOf(tree))).length;

const treeOpens = (trace, root, tree) =>
  tree === ""
    ? 0
    : trace.filter((dir) => dir.slice(root.length).split("/").includes(leafOf(tree))).length;

const denoMatrix = () => {
  const rows = [];
  for (const [id, [dirs, into]] of Object.entries(MEASURED)) {
    const root = join(MATRIX, id);
    const { spec, entry } = caseEntry(root, id);
    if (!existsSync(entry)) throw new Error(`matrix_case_missing:${entry}`);
    const result = denoResolve(RFS, entry, everythingCorpus(RFS, root), identityOrder);
    const tree = spec.noise_at ?? spec.noise_at_root ?? "";
    const simInto = harnessOpensInto(result.trace, tree);
    rows.push({
      id,
      denoDirs: dirs,
      simDirs: result.opendir,
      denoInto: into,
      simInto,
      inTree: treeOpens(result.trace, root, tree),
      files: result.files.size,
      ok: result.opendir === dirs && simInto === into,
    });
  }
  return rows;
};

const inMemory = (repo) => {
  const fs = memFS(repo.nodes);
  return denoResolve(fs, repo.entryFile, everythingCorpus(fs, repo.root), identityOrder);
};

const expansionCalibration = () => {
  const sample = inMemory(sampleRepo(MEASURED_EXPANSION.sampleNoise));
  const arms = Object.entries(POSITION_ARMS).map(([position, measured]) => {
    const repo = positionControlRepo(MEASURED_EXPANSION.controlDirs, position);
    const result = inMemory(repo);
    const simT0 = opensInto(result, "T0", "/.venv");
    return {
      position,
      treeDirs: repo.treeDirs,
      simT0,
      simAll: result.trace.filter((dir) => dir.includes("/.venv")).length,
      measured,
      ok: simT0 === measured.expansion,
    };
  });
  return {
    sample,
    arms,
    ok: sample.opens.T0 === MEASURED_EXPANSION.sampleStack && arms.every((arm) => arm.ok),
  };
};

const presetExpansion = () =>
  Object.entries(PRESETS).map(([name, spec]) => {
    const repo = realisticMonorepo({ ...spec, seed: PRESET_SEED });
    const result = inMemory(repo);
    const trees = (spec.memberTrees ?? []).map((tree) => tree.name);
    const declared = [...repo.members].map((member) => member.replace("./", `${repo.root}/`)).sort();
    return {
      name,
      dirs: countDirs(repo.nodes),
      t0: result.opens.T0,
      t1: result.opens.T1,
      t2: result.opens.T2,
      t3: result.opens.T3,
      total: result.opendir,
      memberTrees: trees.join(",") === "" ? "none" : trees.join(","),
      inTrees: trees.reduce((sum, tree) => sum + opensInto(result, "T0", `/${tree}`), 0),
      members: result.globMembers.length,
      ok: result.globMembers.join("|") === declared.join("|"),
    };
  });

const tscMatrix = () => {
  const rows = [];
  for (const id of readdirSync(CASES).sort()) {
    const root = join(MATRIX, id);
    const { entry } = caseEntry(root, id);
    if (!existsSync(entry)) throw new Error(`matrix_case_missing:${entry}`);
    const real = listFiles(findConfig(RFS, dirname(entry)), root);
    const sim = tscResolve(RFS, entry, everythingCorpus(RFS, root), identityOrder);
    const missing = [...real].filter((file) => !sim.files.has(file));
    const extra = [...sim.files].filter((file) => !real.has(file));
    rows.push({
      id,
      real: real.size,
      sim: sim.files.size,
      dirs: sim.opendir,
      missing: missing.length,
      extra: extra.length,
      ok: missing.length === 0 && extra.length === 0,
    });
  }
  return rows;
};

const tscSemantics = () => {
  const rows = [];
  for (const testCase of materialiseFixture(FIXTURE_ROOT)) {
    const real = listFiles(join(testCase.dir, "tsconfig.json"), testCase.dir);
    const sim = tscResolve(RFS, testCase.entry, everythingCorpus(RFS, testCase.dir), identityOrder);
    const missing = [...real].filter((file) => !sim.files.has(file));
    const extra = [...sim.files].filter((file) => !real.has(file));
    const unexpected = [...real].filter((file) => !testCase.expect.has(file));
    const absent = [...testCase.expect].filter((file) => !real.has(file));
    rows.push({
      id: testCase.id,
      claim: testCase.claim,
      real: real.size,
      sim: sim.files.size,
      stated: testCase.expect.size,
      ok: missing.length + extra.length + unexpected.length + absent.length === 0,
    });
  }
  return rows;
};

const artifactsUnder = (root) => {
  const found = [];
  const walk = (dir) => {
    for (const entry of RFS.readdir(dir)) {
      const path = join(dir, entry.name);
      if (entry.dir) walk(path);
      else if (ARTIFACT.test(entry.name)) found.push(path);
    }
  };
  walk(root);
  return found;
};

const table = (header, widths, rows) => {
  console.log(header.map((name, i) => (i === 0 ? cell(name, widths[i]) : pad(name, widths[i]))).join("  "));
  for (const row of rows) {
    console.log(row.map((value, i) => (i === 0 ? cell(value, widths[i]) : pad(value, widths[i]))).join("  "));
  }
};

const verdictOf = (rows) => `${rows.filter((row) => row.ok).length}/${rows.length}`;

const deno = denoMatrix();
console.log("## deno.mjs vs measured deno 2.9.5, 46 workspace configurations\n");
table(
  ["case", "sim_dirs", "deno_dirs", "sim_into", "deno_into", "in_tree", "files", "verdict"],
  [22, 9, 10, 9, 10, 8, 6, 9],
  deno.map((row) => [
    row.id, row.simDirs, row.denoDirs, row.simInto, row.denoInto, row.inTree, row.files,
    row.ok ? "exact" : "MISMATCH",
  ])
);
console.log(`\nexact: ${verdictOf(deno)}\n`);

const expansion = expansionCalibration();
console.log("## deno.mjs T0 vs the measured member-glob expansion\n");
console.log(
  `  sample at NOISE=${MEASURED_EXPANSION.sampleNoise}: T0=${expansion.sample.opens.T0}` +
    `  measured stack 1 = ${MEASURED_EXPANSION.sampleStack} of ${MEASURED_EXPANSION.sampleTotal} opens` +
    `  (T1=${expansion.sample.opens.T1}, T2=${expansion.sample.opens.T2}, T3=${expansion.sample.opens.T3})`
);
console.log("");
table(
  ["arm", "tree_dirs", "sim_T0", "deno_expansion", "sim_all", "deno_all", "verdict"],
  [16, 10, 8, 15, 8, 9, 9],
  expansion.arms.map((arm) => [
    arm.position, arm.treeDirs, arm.simT0, arm.measured.expansion, arm.simAll, arm.measured.all,
    arm.ok ? "exact" : "MISMATCH",
  ])
);
console.log(
  `\n  positional law: ${expansion.arms[0].simT0} opens inside a matched member, ` +
    `${expansion.arms[1].simT0} outside the glob prefix; the traced expansion stack ` +
    `made ${POSITION_ARMS["inside-member"].expansion} and ${POSITION_ARMS["at-root"].expansion}`
);
console.log(`  expansion: ${expansion.ok ? "calibrated" : "MISMATCH"}\n`);

const presets = presetExpansion();
console.log("## deno.mjs per traversal, the four presets in lib/realistic.mjs\n");
table(
  ["preset", "tree_dirs", "T0", "T1", "T2", "T3", "total", "T0_in_trees", "member_trees", "members"],
  [10, 10, 8, 8, 8, 7, 8, 12, 14, 8],
  presets.map((row) => [
    row.name, row.dirs, row.t0, row.t1, row.t2, row.t3, row.total, row.inTrees, row.memberTrees,
    row.ok ? row.members : `MISMATCH ${row.members}`,
  ])
);
console.log("");

const matrix = tscMatrix();
console.log("## typescript.mjs vs tsc --listFiles, the same 46 trees\n");
table(
  ["case", "tsc_files", "sim_files", "sim_dirs", "verdict"],
  [22, 10, 10, 9, 9],
  matrix.map((row) => [
    row.id, row.real, row.sim, row.dirs,
    row.ok ? "match" : `MISS ${row.missing}/+${row.extra}`,
  ])
);
console.log(`\nmatch: ${verdictOf(matrix)}\n`);

const semantics = tscSemantics();
console.log("## typescript.mjs vs tsc --listFiles, purpose-built semantics fixture\n");
table(
  ["case", "stated", "tsc_files", "sim_files", "verdict"],
  [37, 7, 10, 10, 9],
  semantics.map((row) => [
    row.id, row.stated, row.real, row.sim, row.ok ? "match" : "MISMATCH",
  ])
);
console.log("");
for (const row of semantics) console.log(`  ${cell(row.id, 37)}  ${row.claim}`);
console.log(`\nmatch: ${verdictOf(semantics)}\n`);

const artifacts = artifactsUnder(MATRIX);
console.log("## build-artifact check\n");
console.log(`  ${MATRIX}: ${artifacts.length} of *.js, *.d.ts, *.tsbuildinfo`);
for (const path of artifacts.slice(0, 20)) console.log(`    ${path}`);

const failures = [
  ...(expansion.ok ? [] : ["expansion:positional"]),
  ...presets.filter((row) => !row.ok).map((row) => `expansion-members:${row.name}`),
  ...deno.filter((row) => !row.ok).map((row) => `deno:${row.id}`),
  ...matrix.filter((row) => !row.ok).map((row) => `tsc-matrix:${row.id}`),
  ...semantics.filter((row) => !row.ok).map((row) => `tsc-semantics:${row.id}`),
  ...(artifacts.length === 0 ? [] : [`artifacts:${artifacts.length}`]),
];

console.log("\n## summary\n");
console.log(`  deno.mjs        ${verdictOf(deno)} exact on opendir and opens-into-tree (T0 fires on none of them)`);
console.log(`  deno.mjs T0     ${expansion.ok ? "sample exact, positional control reproduced" : "MISMATCH"}`);
console.log(`  typescript.mjs  ${verdictOf(matrix)} on the matrix trees`);
console.log(`  typescript.mjs  ${verdictOf(semantics)} on the semantics fixture`);
console.log(`  artifacts       ${artifacts.length === 0 ? "none written into the matrix" : "MATRIX POLLUTED"}`);
console.log(`\n${failures.length === 0 ? "PASS" : `FAIL: ${failures.join(", ")}`}`);
process.exitCode = failures.length === 0 ? 0 : 1;
