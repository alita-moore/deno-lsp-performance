import { memFS } from "../../lib/fs.mjs";
import { listCorpus } from "../../lib/corpus.mjs";
import { identityOrder } from "../../lib/order.mjs";
import { CANDIDATES, expandOnly } from "./ablation.mjs";
import { vcsIgnoreMatcher } from "./discovery.mjs";
import { CONDITIONS, buildRepo } from "./repo.mjs";
import { dirsOf, fix, pad, rpad } from "../../lib/metrics.mjs";

const PER_DIR_MS = 1.544;
const CONFIG_LOADS = 2;

const SWEPT = ["deno", "M1", "M2", "M4", "M5", "M5+M4"];

const VARIANTS = SWEPT.map((name) => {
  const spec = CANDIDATES.find((candidate) => candidate.name === name);
  if (spec === undefined) throw new Error(`no_candidate:${name}`);
  return spec;
});

const REPORTED = Object.freeze({
  packages: 53,
  filesPerPackage: 45,
  depth: 4,
  rootVendor: 2000,
  perPackageVendor: 8,
  vendorDepth: 2,
  tsconfig: "typical",
  npmWorkspaces: true,
  memberTrees: [
    { name: ".venv", packages: 120, depth: 3 },
    { name: ".cache", packages: 20, depth: 2 },
  ],
});

const scaled = (k) => ({
  ...REPORTED,
  packages: Math.round(REPORTED.packages * k),
  rootVendor: Math.round(REPORTED.rootVendor * k),
  memberTrees: REPORTED.memberTrees.map((tree) => ({
    ...tree,
    packages: Math.round(tree.packages * k),
  })),
});

const withVenv = (packages) => ({
  ...REPORTED,
  memberTrees: [
    { name: ".venv", packages, depth: 3 },
    { name: ".cache", packages: 20, depth: 2 },
  ],
});

const AXES = [
  {
    key: "size",
    label: "whole repository scaled: members, root vendor tree and in-member vendor trees together",
    points: [0.25, 0.5, 1, 2, 4].map((k) => ({ at: `${k}x`, spec: scaled(k) })),
  },
  {
    key: "in-member",
    label: "in-member vendor mass alone, member count and source tree held fixed",
    points: [0, 15, 30, 60, 120, 240, 480].map((packages) => ({
      at: String(packages),
      spec: withVenv(packages),
    })),
  },
];

const point = (spec, condition) => {
  const repo = buildRepo(spec, condition, 1);
  const fs = memFS(repo.nodes);
  const corpus = listCorpus(repo.root, repo.tracked);
  const ignored = vcsIgnoreMatcher(fs, repo.root);
  const allDirs = dirsOf(repo.nodes);
  const inMember = allDirs.filter(
    (path) => path.startsWith(`${repo.root}/packages/`) && !corpus.covers(path)
  ).length;
  const base = expandOnly(fs, repo.root, identityOrder(), VARIANTS[0], ignored);
  const opens = new Map();
  for (const variant of VARIANTS) {
    const result = expandOnly(fs, repo.root, identityOrder(), variant, ignored);
    if (result.members.join("|") !== base.members.join("|"))
      throw new Error(`member_set_changed:${variant.name}`);
    opens.set(variant.name, result.opendir * (variant.memoised ? 1 : CONFIG_LOADS));
  }
  return { dirs: allDirs.length, inMember, members: base.members.length, opens };
};

const slope = (xs, ys) => {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  if (den === 0) throw new Error("degenerate_axis");
  return num / den;
};

const seconds = (opens) => `${((opens * PER_DIR_MS) / 1000).toFixed(1)}s`;

console.log(`\nARENA 3 - SCALE OF THE MEMBER-GLOB EXPANSION   opendir cost=${PER_DIR_MS}ms, charged ${CONFIG_LOADS} loads`);
console.log(
  `Every wall-clock figure is a PROJECTION: directory opens multiplied by the measured per-open cost on a bind mount.`
);

for (const condition of CONDITIONS.filter((c) => c.key === "A")) {
  for (const axis of AXES) {
    const measured = axis.points.map((p) => ({ at: p.at, ...point(p.spec, condition) }));
    console.log(`\n\nAXIS ${axis.key}: ${axis.label}`);
    console.log(
      `  ${pad("at", 8)}${rpad("dirs", 9)}${rpad("in-member", 11)}${rpad("members", 9)}` +
        VARIANTS.map((v) => rpad(v.name, 11)).join("")
    );
    for (const m of measured)
      console.log(
        `  ${pad(m.at, 8)}${rpad(m.dirs, 9)}${rpad(m.inMember, 11)}${rpad(m.members, 9)}` +
          VARIANTS.map((v) => rpad(m.opens.get(v.name), 11)).join("")
      );
    console.log(
      `  ${pad("proj", 8)}${rpad("", 9)}${rpad("", 11)}${rpad("", 9)}` +
        VARIANTS.map((v) => rpad(seconds(measured.at(-1).opens.get(v.name)), 11)).join("")
    );
    console.log(`\n  opens = m * (in-member untracked directories) + b`);
    console.log(`  ${pad("variant", 12)}${rpad("m", 10)}${rpad("opens@last", 12)}`);
    for (const variant of VARIANTS)
      console.log(
        `  ${pad(variant.name, 12)}` +
          `${rpad(fix(slope(measured.map((m) => m.inMember), measured.map((m) => m.opens.get(variant.name))), 3), 10)}` +
          `${rpad(measured.at(-1).opens.get(variant.name), 12)}`
      );
  }
}
console.log("");
