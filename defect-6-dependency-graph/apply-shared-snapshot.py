import sys, pathlib

ROOT = pathlib.Path(sys.argv[1])

RES = "libs/resolver/npm/managed/resolution.rs"
MOD = "libs/resolver/npm/managed/mod.rs"
LSP = "cli/lsp/resolver.rs"

A1_A = """#[allow(clippy::disallowed_types, reason = "definition")]
pub type NpmResolutionCellRc = deno_maybe_sync::MaybeArc<NpmResolutionCell>;
"""
A1_R = """#[allow(clippy::disallowed_types, reason = "definition")]
pub type NpmResolutionCellRc = deno_maybe_sync::MaybeArc<NpmResolutionCell>;

#[allow(
  clippy::disallowed_types,
  reason = "sharing one snapshot between cells must not depend on the sync feature"
)]
pub type NpmResolutionSnapshotRc = std::sync::Arc<NpmResolutionSnapshot>;
"""

A2_A = """  snapshot: RwLock<NpmResolutionSnapshot>,
"""
A2_R = """  snapshot: RwLock<NpmResolutionSnapshotRc>,
"""

A3_A = """      snapshot: RwLock::new(initial_snapshot),
"""
A3_R = """      snapshot: RwLock::new(NpmResolutionSnapshotRc::new(initial_snapshot)),
"""

A4_A = """  pub fn snapshot(&self) -> NpmResolutionSnapshot {
    self.snapshot.read().clone()
  }
"""
A4_R = """  pub fn snapshot(&self) -> NpmResolutionSnapshot {
    (**self.snapshot.read()).clone()
  }

  pub fn snapshot_rc(&self) -> NpmResolutionSnapshotRc {
    self.snapshot.read().clone()
  }
"""

A5_A = """  pub fn set_snapshot(&self, snapshot: NpmResolutionSnapshot) {
    *self.snapshot.write() = snapshot;
  }
"""
A5_R = """  pub fn set_snapshot(&self, snapshot: NpmResolutionSnapshot) {
    *self.snapshot.write() = NpmResolutionSnapshotRc::new(snapshot);
  }

  pub fn set_snapshot_rc(&self, snapshot: NpmResolutionSnapshotRc) {
    *self.snapshot.write() = snapshot;
  }
"""

B1_A = """pub use self::resolution::NpmResolutionCellRc;
"""
B1_R = """pub use self::resolution::NpmResolutionCellRc;
pub use self::resolution::NpmResolutionSnapshotRc;
"""

C1_A = """      .set_snapshot(self.npm_resolution.snapshot());
"""
C1_R = """      .set_snapshot_rc(self.npm_resolution.snapshot_rc());
"""

EDITS = [
    (RES, A1_A, A1_R),
    (RES, A2_A, A2_R),
    (RES, A3_A, A3_R),
    (RES, A4_A, A4_R),
    (RES, A5_A, A5_R),
    (MOD, B1_A, B1_R),
    (LSP, C1_A, C1_R),
]

sources = {rel: (ROOT / rel).read_text() for rel, _, _ in EDITS}

failures = []
for rel, anchor, _ in EDITS:
    n = sources[rel].count(anchor)
    if n != 1:
        failures.append(f"FAIL {rel}: anchor count {n}\n{anchor[:120]}")
if failures:
    sys.exit("\n".join(failures))

for rel, anchor, replacement in EDITS:
    sources[rel] = sources[rel].replace(anchor, replacement)
    print(f"ok  {rel:40} {len(anchor.splitlines())}-line anchor")

for rel, text in sources.items():
    (ROOT / rel).write_text(text)

print(f"shared snapshot applied: {len(EDITS)} edits across {len(sources)} files")
