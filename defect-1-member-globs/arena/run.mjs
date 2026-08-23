import { memFS } from "../../lib/fs.mjs";
import { listCorpus } from "../../lib/corpus.mjs";
import { identityOrder } from "../../lib/order.mjs";
import { denoResolve } from "../../simulators/deno.mjs";
import { BASE, CANDIDATES, denoModel, expandOnly } from "./ablation.mjs";
import { MECHANISMS, MEMOISE, invasivenessOf, sitesOf, vcsIgnoreMatcher } from "./discovery.mjs";
import { ADVERSARIAL, CONDITIONS, PRESET_LIST, buildRepo } from "./repo.mjs";
import {
  dirsOf,
  fix,
  pad,
  pct,
  quantile,
  rpad,
  sameFiles,
  sameTrace,
  timed,
  yesNo,
} from "../../lib/metrics.mjs";

const PER_DIR_MS = 1.544;
const CONFIG_LOADS = 2;

const numArg = (flag, dflt) => {
  const at = process.argv.indexOf(flag);
  return at === -1 ? dflt : Number(process.argv[at + 1]);
};

const SEED = numArg("--seed", 1);
const REPEATS = numArg("--repeats", 7);
const WARMUP = numArg("--warmup", 2);
const SEEDS = [1, 2, 3];

const seconds = (opens) => `${((opens * PER_DIR_MS) / 1000).toFixed(1)}s`;
const missingFrom = (truth, found) => truth.filter((member) => !found.includes(member));
const extraIn = (truth, found) => found.filter((member) => !truth.includes(member));

const measurePreset = (preset, condition, seed, repeats, warmup) => {
  const repo = buildRepo(preset.spec, condition, seed);
  const fs = memFS(repo.nodes);
  const corpus = listCorpus(repo.root, repo.tracked);
  const ignored = vcsIgnoreMatcher(fs, repo.root);
  const allDirs = dirsOf(repo.nodes);
  const trackedDirs = allDirs.filter((path) => corpus.covers(path)).length;

  const control = denoModel(fs, repo.entryFile, corpus, identityOrder(), BASE, ignored);
  const reference = denoResolve(fs, repo.entryFile, corpus, identityOrder());
  if (
    !sameTrace(control.trace, reference.trace) ||
    !sameFiles(control.files, reference.files) ||
    control.globMembers.join("|") !== reference.globMembers.join("|")
  )
    throw new Error(`fidelity_drift:${condition.key}:${preset.name}`);

  const declared = [...repo.members].map((member) => member.replace("./", `${repo.root}/`)).sort();
  const truth = condition.expandsMembers ? declared : [];
  if (control.globMembers.join("|") !== truth.join("|"))
    throw new Error(`base_member_set_wrong:${condition.key}:${preset.name}`);
  const rows = CANDIDATES.map((spec) => {
    const run = timed(
      () => denoModel(fs, repo.entryFile, corpus, identityOrder(), spec, ignored),
      warmup,
      repeats
    );
    const result = run.result;
    if (!sameFiles(result.files, control.files))
      throw new Error(`index_changed_by_t0:${condition.key}:${preset.name}:${spec.name}`);
    const loads = spec.memoised ? 1 : CONFIG_LOADS;
    return {
      spec,
      t0: result.opens.T0,
      t0Charged: result.opens.T0 * loads,
      rest: result.opendir - result.opens.T0,
      total: result.opens.T0 * loads + (result.opendir - result.opens.T0),
      distinct: new Set(result.trace).size,
      members: result.globMembers.length,
      missed: missingFrom(truth, result.globMembers).length,
      extra: extraIn(truth, result.globMembers).length,
      samples: run.samples,
    };
  });

  return {
    preset: preset.name,
    condition: condition.key,
    dirs: allDirs.length,
    trackedDirs,
    truth: truth.length,
    rows,
  };
};

const measureCase = (repo, spec) => {
  const fs = memFS(repo.nodes);
  const ignored = vcsIgnoreMatcher(fs, repo.root);
  const result = expandOnly(fs, repo.root, identityOrder(), spec, ignored);
  return {
    spec,
    t0: result.opendir,
    members: result.members.length,
    missed: missingFrom([...repo.trueMembers], result.members),
    extra: extraIn([...repo.trueMembers], result.members),
  };
};

const findRow = (rows, name) => {
  const row = rows.find((entry) => entry.spec.name === name);
  if (row === undefined) throw new Error(`no_row:${name}`);
  return row;
};

console.log(
  `\nARENA 3 - choosing the mechanism   seed=${SEED}  repeats=${REPEATS}  warmup=${WARMUP}  opendir cost=${PER_DIR_MS}ms`
);
console.log(
  `\nFIDELITY CONTROL: an unmodified local copy of the model is trace-identical, file-identical and member-identical to` +
    `\nsimulators/deno.mjs on every preset in every condition. The run aborts otherwise. A second control asserts that no` +
    `\ncandidate changes the indexed file set, since a member-expansion change must not.`
);
console.log(
  `\nT0 is the member-glob expansion, the traversal simulators/deno.mjs calibrates against ../diagnosis. T0_ub charges` +
    `\nit ${CONFIG_LOADS} times, which is an UPPER BOUND and not a law: the traced second expansion is smaller than the first` +
    `\n(8,192 against 12,009 opens on the sample), so M4's saving is at most what this column shows. Every other candidate's` +
    `\ngain is a ratio and is unaffected by the multiplier.` +
    `\n\nT1+T2+T3 is carried for context only. The simulator's author records that T1 over-counts trees outside the glob` +
    `\nprefix - 1,601 modelled opens where real deno makes 1, because walk_workspace's 1,000-entry cap is unmodelled - so` +
    `\nthe total and its projection are inflated. No recommendation here banks on a T1 saving; proj_T0 is the column to read.`
);

const measured = CONDITIONS.map((condition) => ({
  condition,
  presets: PRESET_LIST.map((preset) => measurePreset(preset, condition, SEED, REPEATS, WARMUP)),
}));

for (const { condition, presets } of measured) {
  console.log(`\n\n================ CONDITION ${condition.key}: ${condition.label} ================`);
  console.log(
    `\n  ${pad("preset", 10)}${pad("candidate", 14)}${rpad("T0", 8)}${rpad("T0_ub", 8)}${rpad("T1+T2+T3", 10)}` +
      `${rpad("total", 9)}${rpad("members", 9)}${rpad("missed", 8)}${rpad("extra", 7)}${rpad("gain_T0", 9)}` +
      `${rpad("proj_T0", 10)}${rpad("proj_all", 10)}${rpad("us_median", 11)}`
  );
  for (const m of presets) {
    const base = findRow(m.rows, "deno");
    const floor = findRow(m.rows, "M5").t0;
    const available = base.t0Charged - floor;
    for (const row of m.rows)
      console.log(
        `  ${pad(m.preset, 10)}${pad(row.spec.name, 14)}${rpad(row.t0, 8)}${rpad(row.t0Charged, 8)}` +
          `${rpad(row.rest, 10)}${rpad(row.total, 9)}${rpad(row.members, 9)}${rpad(row.missed, 8)}` +
          `${rpad(row.extra, 7)}` +
          `${rpad(available === 0 ? "-" : pct((base.t0Charged - row.t0Charged) / available, 1), 9)}` +
          `${rpad(seconds(row.t0Charged), 10)}${rpad(seconds(row.total), 10)}` +
          `${rpad(fix(quantile(row.samples, 0.5), 1), 11)}`
      );
  }
}

console.log(`\n\n================ FALSE NEGATIVES: ADVERSARIAL WORKSPACES ================`);
console.log(
  `\nEach case is a repository whose members are declared in a way that separates the mechanisms. "missed" counts` +
    `\nlegitimate members the expansion no longer discovers. A single missed member is a correctness regression.`
);
for (const repo of ADVERSARIAL) {
  console.log(`\n  ${repo.name}: ${repo.question}`);
  console.log(
    `    workspaces ${JSON.stringify(repo.workspaces)}, ${repo.trueMembers.length} real members, ${repo.nodes.size} nodes`
  );
  console.log(
    `    ${pad("candidate", 14)}${rpad("T0 opens", 10)}${rpad("members", 9)}${rpad("missed", 8)}${rpad("extra", 7)}${rpad("correct", 9)}`
  );
  for (const spec of CANDIDATES) {
    const row = measureCase(repo, spec);
    console.log(
      `    ${pad(spec.name, 14)}${rpad(row.t0, 10)}${rpad(row.members, 9)}${rpad(row.missed.length, 8)}` +
        `${rpad(row.extra.length, 7)}${rpad(yesNo(row.missed.length === 0 && row.extra.length === 0), 9)}`
    );
  }
}

console.log(`\n\n================ MECHANISMS AND INVASIVENESS ================`);
console.log(
  `\nPoints: 1 per function whose body changes; 0 for input already at the call site, 2 for a file the process does not` +
    `\nread today; 0/1/2 for user-visible behaviour change.`
);
console.log(
  `\n  ${pad("id", 4)}${pad("title", 68)}${rpad("fn", 4)}${rpad("in", 4)}${rpad("vis", 5)}${rpad("total", 7)}  ${pad("call site", 60)}`
);
for (const [key, mechanism] of [...Object.entries(MECHANISMS), ...Object.entries(MEMOISE)])
  console.log(
    `  ${pad(key, 4)}${pad(mechanism.title, 68)}${rpad(mechanism.functions, 4)}${rpad(mechanism.input, 4)}` +
      `${rpad(mechanism.visible, 5)}${rpad(mechanism.functions + mechanism.input + mechanism.visible, 7)}  ${pad(mechanism.site, 60)}`
  );

for (const { condition, presets } of measured) {
  const reported = presets.find((m) => m.preset === "reported");
  const base = findRow(reported.rows, "deno");
  const floor = findRow(reported.rows, "M5").t0;
  const available = base.t0Charged - floor;
  const anyMiss = (name) =>
    ADVERSARIAL.some((repo) => {
      const row = measureCase(repo, CANDIDATES.find((spec) => spec.name === name));
      return row.missed.length > 0;
    });
  console.log(
    `\nCONDITION ${condition.key} - ranked by T0 gain per point of invasiveness on the reported preset.` +
      ` "safe" is no missed member in any adversarial case.`
  );
  if (available === 0) {
    console.log(`  the expansion opens nothing in this condition, so there is no gain to rank`);
    continue;
  }
  console.log(
    `  ${pad("rank", 6)}${pad("candidate", 14)}${rpad("invasive", 10)}${rpad("gain_T0", 9)}${rpad("gain/point", 12)}` +
      `${rpad("safe", 6)}  ${pad("call sites", 60)}`
  );
  CANDIDATES.filter((spec) => spec.name !== "deno")
    .map((spec) => {
      const row = findRow(reported.rows, spec.name);
      const cost = invasivenessOf(spec.mechanisms, spec.memoised);
      const gain = (base.t0Charged - row.t0Charged) / available;
      return { spec, cost, gain, ratio: gain / cost, safe: !anyMiss(spec.name) };
    })
    .sort((a, b) => b.ratio - a.ratio)
    .forEach((entry, i) =>
      console.log(
        `  ${pad(i + 1, 6)}${pad(entry.spec.name, 14)}${rpad(entry.cost, 10)}${rpad(pct(entry.gain, 1), 9)}` +
          `${rpad(fix(100 * entry.ratio, 1), 12)}${rpad(yesNo(entry.safe), 6)}  ` +
          `${pad(sitesOf(entry.spec.mechanisms, entry.spec.memoised), 60)}`
      )
    );
}

console.log(`\n\n================ SEED STABILITY OF THE STRUCTURAL COLUMNS ================`);
const structural = (row) => [row.t0, row.rest, row.distinct, row.members, row.missed].join("/");
for (const condition of CONDITIONS)
  for (const preset of PRESET_LIST) {
    const runs = SEEDS.map((seed) => measurePreset(preset, condition, seed, 1, 0));
    for (const spec of CANDIDATES) {
      const values = runs.map((m) => structural(findRow(m.rows, spec.name)));
      if (new Set(values).size !== 1)
        throw new Error(
          `structural_column_unstable:${condition.key}:${preset.name}:${spec.name}:${values.join(" ")}`
        );
    }
  }
console.log(
  `  T0 opens, the rest of the opens, distinct directories, discovered members and missed members are identical at seeds` +
    ` ${SEEDS.join(", ")}\n  for every candidate, preset and condition.`
);
console.log("");
