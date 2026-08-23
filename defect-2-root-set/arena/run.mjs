import { memFS } from "../../lib/fs.mjs";
import { listCorpus } from "../../lib/corpus.mjs";
import { identityOrder } from "../../lib/order.mjs";
import { denoResolve } from "../../simulators/deno.mjs";
import { vcsIgnoreMatcher } from "../../defect-1-member-globs/arena/discovery.mjs";
import { vcsIgnore } from "./vcs.mjs";
import { dirsOf, pad, rpad, sameFiles, sameTrace, timed } from "../../lib/metrics.mjs";
import { BASE, CANDIDATES, invasivenessOf, sitesOf, MECHANISMS } from "./mechanisms.mjs";
import { denoModel } from "./model.mjs";
import { importClosure } from "./recovery.mjs";
import { ADVERSARIAL, CONDITIONS, PRESET_LIST, buildRepo } from "./repo.mjs";
import { PRESETS } from "../../lib/realistic.mjs";

const PER_DIR_MS = 1.544;

const numArg = (flag, dflt) => {
  const at = process.argv.indexOf(flag);
  return at === -1 ? dflt : Number(process.argv[at + 1]);
};

const SEED = numArg("--seed", 1);
const REPEATS = numArg("--repeats", 7);
const WARMUP = numArg("--warmup", 2);
const SEEDS = [1, 2, 3];

const seconds = (opens) => `${((opens * PER_DIR_MS) / 1000).toFixed(1)}s`;
const gainOf = (base, value) => (base === 0 ? 0 : (100 * (base - value)) / base);

const lostOf = (fs, base, run, mustKeep) => {
  const dropped = [...base.rootSet].filter((file) => !run.rootSet.has(file));
  const reachable = importClosure(fs, run.rootSet);
  const baseReachable = importClosure(fs, base.rootSet);
  const recovered = dropped.filter((file) => reachable.has(file));
  const required = mustKeep.filter((file) => baseReachable.has(file) && !reachable.has(file));
  return { dropped: dropped.length, recovered: recovered.length, lost: required.length, reachable };
};

const fateOf = (run, recovery, subject) =>
  run.rootSet.has(subject) ? "seed" : recovery.reachable.has(subject) ? "graph" : "gone";

const measurePreset = (preset, condition, seed, repeats, warmup) => {
  const repo = buildRepo(preset.spec, condition, seed);
  const fs = memFS(repo.nodes);
  const corpus = listCorpus(repo.root, repo.tracked);
  const ignored = vcsIgnore(fs, repo.root);
  const reference0 = vcsIgnoreMatcher(fs, repo.root);
  for (const path of repo.nodes.keys())
    if (reference0(path) !== ignored.ignored(path)) throw new Error(`ignore_matcher_drift:${path}`);
  const trackedScripts = repo.tracked.filter((file) => /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(file));
  const control = denoModel(fs, repo.entryFile, corpus, identityOrder(), BASE, ignored);
  const reference = denoResolve(fs, repo.entryFile, corpus, identityOrder());
  if (
    !sameTrace(control.trace, reference.trace) ||
    !sameFiles(control.files, reference.files) ||
    control.globMembers.join("|") !== reference.globMembers.join("|")
  )
    throw new Error(`fidelity_drift:${condition.key}:${preset.name}`);

  const rows = CANDIDATES.map((spec) => {
    const run = timed(
      () => denoModel(fs, repo.entryFile, corpus, identityOrder(), spec, ignored),
      warmup,
      repeats
    );
    const result = run.result;
    if (spec.mechanisms.join("|") === "R4" && !sameFiles(result.rootSet, control.rootSet))
      throw new Error(`sharing_changed_the_root_set:${condition.key}:${preset.name}`);
    const rootSetCost = result.opens.T2 + result.opens.T3;
    const recovery = lostOf(fs, control, result, trackedScripts);
    return {
      spec,
      t2: result.opens.T2,
      t3: result.opens.T3,
      cost: rootSetCost,
      rest: result.opendir - rootSetCost,
      roots: result.rootSet.size,
      ...recovery,
      samples: run.samples,
    };
  });

  const base = rows[0].cost;
  for (const row of rows) row.gain = gainOf(base, row.cost);
  return { preset: preset.name, condition: condition.key, dirs: dirsOf(repo.nodes).length, rows };
};

const measureCase = (kase, spec) => {
  const fs = memFS(kase.nodes);
  const corpus = listCorpus(kase.root, []);
  const ignored = vcsIgnore(fs, kase.root);
  const control = denoModel(fs, kase.entryFile, corpus, identityOrder(), BASE, ignored);
  const result = denoModel(fs, kase.entryFile, corpus, identityOrder(), spec, ignored);
  const recovery = lostOf(fs, control, result, [...kase.mustKeep]);
  return {
    spec,
    cost: result.opens.T2 + result.opens.T3,
    baseCost: control.opens.T2 + control.opens.T3,
    dropped: recovery.dropped,
    recovered: recovery.recovered,
    lost: recovery.lost,
    fate: fateOf(result, recovery, kase.subject),
  };
};

const SHOWN = ["deno", "R1", "R2", "R3", "R4", "X1", "X2", "R1+R4", "R1+R3+R4"];
const rowOf = (rows, name) => {
  const row = rows.find((entry) => entry.spec.name === name);
  if (row === undefined) throw new Error(`no_row:${name}`);
  return row;
};

console.log(
  `\nARENA 4 - choosing the mechanism for the tsconfig root-set collection` +
    `\nseed=${SEED}  repeats=${REPEATS}  warmup=${WARMUP}  projection basis=${PER_DIR_MS}ms per opendir`
);
console.log(
  `\nFIDELITY CONTROL: with every mechanism disabled this model is trace-identical, file-identical and` +
    `\nmember-identical to simulators/deno.mjs on every preset in every condition. Two further controls abort the run:` +
    `\nthe local .gitignore matcher must agree with defect-1-member-globs/arena on every path, and sharing one traversal` +
    `\nacross overlapping bases (R4) must leave the collected root set unchanged.`
);
console.log(
  `\nThe measured quantity is T2 + T3, the two collect_specifiers traversals that from_inner drives. T0 and T1` +
    `\nbelong to the other two defects and are reported as "rest" so nothing is smuggled between subsystems.`
);

const table = [];
for (const condition of CONDITIONS) {
  console.log(`\n\ncondition ${condition.key} - ${condition.label}\n`);
  console.log(
    `  ${pad("preset", 10)}${pad("candidate", 12)}${rpad("T2", 7)}${rpad("T3", 6)}${rpad("T2+T3", 8)}` +
      `${rpad("gain", 8)}${rpad("roots", 8)}${rpad("dropped", 9)}${rpad("recov", 7)}${rpad("lost", 6)}${rpad("proj", 8)}`
  );
  for (const preset of PRESET_LIST) {
    const measured = measurePreset(preset, condition, SEED, REPEATS, WARMUP);
    table.push(measured);
    for (const name of SHOWN) {
      const row = rowOf(measured.rows, name);
      console.log(
        `  ${pad(preset.name, 10)}${pad(name, 12)}${rpad(row.t2, 7)}${rpad(row.t3, 6)}${rpad(row.cost, 8)}` +
          `${rpad(`${row.gain.toFixed(1)}%`, 8)}${rpad(row.roots, 8)}${rpad(row.dropped, 9)}` +
          `${rpad(row.recovered, 7)}${rpad(row.lost, 6)}${rpad(seconds(row.cost), 8)}`
      );
    }
  }
}

console.log(`\n\nSEED STABILITY - T2+T3, dropped and lost at seeds ${SEEDS.join(", ")}\n`);
let stable = true;
for (const preset of PRESET_LIST) {
  const signatures = SEEDS.map((seed) =>
    measurePreset(preset, CONDITIONS[0], seed, 1, 0)
      .rows.map((row) => `${row.spec.name}:${row.cost}:${row.dropped}:${row.lost}`)
      .join("|")
  );
  const same = signatures.every((signature) => signature === signatures[0]);
  if (!same) stable = false;
  console.log(`  ${pad(preset.name, 10)}${same ? "identical at every seed" : "DIFFERS BY SEED"}`);
}
if (!stable) throw new Error("seed_instability");

console.log(`\n\nFALSE NEGATIVES - what each candidate stops seeding, and whether the module graph recovers it\n`);
console.log(
  `  ${pad("case", 26)}${pad("candidate", 12)}${rpad("T2+T3", 8)}${rpad("dropped", 9)}${rpad("recov", 7)}${rpad("lost", 6)}  subject`
);
const lostByCandidate = new Map(CANDIDATES.map((spec) => [spec.name, 0]));
for (const kase of ADVERSARIAL) {
  for (const name of SHOWN) {
    const spec = CANDIDATES.find((entry) => entry.name === name);
    const measured = measureCase(kase, spec);
    lostByCandidate.set(name, lostByCandidate.get(name) + measured.lost);
    console.log(
      `  ${pad(kase.name, 26)}${pad(name, 12)}${rpad(measured.cost, 8)}${rpad(measured.dropped, 9)}` +
        `${rpad(measured.recovered, 7)}${rpad(measured.lost, 6)}  ${measured.fate}`
    );
  }
  console.log("");
}

console.log(`\nRANKING - condition N, reported preset\n`);
const reported = table.find((entry) => entry.condition === "N" && entry.preset === "reported");
console.log(
  `  ${pad("candidate", 12)}${rpad("invasive", 10)}${rpad("gain", 8)}${rpad("gain/point", 12)}${rpad("lost", 6)}  ${"site"}`
);
const ranked = SHOWN.filter((name) => name !== "deno")
  .map((name) => {
    const row = rowOf(reported.rows, name);
    const points = invasivenessOf(row.spec.mechanisms);
    return {
      name,
      points,
      gain: row.gain,
      perPoint: points === 0 ? row.gain : row.gain / points,
      lost: lostByCandidate.get(name),
      site: sitesOf(row.spec.mechanisms),
    };
  })
  .sort((a, b) => b.perPoint - a.perPoint);
for (const entry of ranked)
  console.log(
    `  ${pad(entry.name, 12)}${rpad(entry.points, 10)}${rpad(`${entry.gain.toFixed(1)}%`, 8)}` +
      `${rpad(entry.perPoint.toFixed(1), 12)}${rpad(entry.lost, 6)}  ${entry.site}`
  );

console.log(`\n\nSCALE - untracked mass inside the tsconfig bases, everything else held fixed\n`);
console.log(
  `  ${rpad("venv/member", 12)}${rpad("dirs", 9)}${rpad("deno", 9)}${rpad("R2", 8)}${rpad("R3", 8)}` +
    `${rpad("R4", 8)}${rpad("X2", 8)}${rpad("R1", 8)}${rpad("R1+R4", 8)}`
);
const fits = new Map(CANDIDATES.map((spec) => [spec.name, []]));
for (const packages of [0, 30, 120, 480]) {
  const spec = { ...PRESETS.reported, memberTrees: [{ name: ".venv", packages, depth: 3 }] };
  const measured = measurePreset({ name: "reported", spec }, CONDITIONS[1], SEED, 1, 0);
  const dirs = measured.dirs;
  const cells = ["deno", "R2", "R3", "R4", "X2", "R1", "R1+R4"].map((name) => {
    const row = rowOf(measured.rows, name);
    fits.get(name).push([packages, row.cost]);
    return rpad(row.cost, 8);
  });
  console.log(`  ${rpad(packages, 12)}${rpad(dirs, 9)}${cells.join("")}`);
}
console.log(`\n  least-squares slope, opens per untracked directory added inside a member\n`);
for (const [name, points] of fits) {
  if (points.length === 0) continue;
  const n = points.length;
  const sx = points.reduce((at, [x]) => at + x, 0);
  const sy = points.reduce((at, [, y]) => at + y, 0);
  const sxy = points.reduce((at, [x, y]) => at + x * y, 0);
  const sxx = points.reduce((at, [x]) => at + x * x, 0);
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  console.log(`  ${pad(name, 12)}m = ${slope.toFixed(3)} per package of .venv per member`);
}
