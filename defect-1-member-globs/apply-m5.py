import sys, pathlib

ROOT = pathlib.Path(sys.argv[1])

MOD = "libs/config/glob/mod.rs"
COL = "libs/config/glob/collector.rs"

H1_A = "  fn as_negated(&self) -> GlobPattern {"
H1_R = """  pub(crate) fn can_match_under_dir(&self, dir: &Path) -> bool {
    if self.base_path.as_os_str().is_empty() {
      return true;
    }
    match dir.strip_prefix(&self.base_path) {
      Ok(relative_base) => self.can_match_under(relative_base),
      Err(_) => true,
    }
  }

  fn as_negated(&self) -> GlobPattern {"""

H2_A = "  /// If this is a negated pattern."
H2_R = """  pub(crate) fn can_match_under_dir(&self, dir: &Path) -> bool {
    match self {
      PathOrPattern::Path(p) => p.starts_with(dir) || dir.starts_with(p),
      PathOrPattern::NegatedPath(_) => false,
      PathOrPattern::RemoteUrl(_) => false,
      PathOrPattern::Pattern(p) => !p.is_negated() && p.can_match_under_dir(dir),
    }
  }

  /// If this is a negated pattern."""

H3_A = "  pub fn base_paths(&self) -> Vec<PathBuf> {"
H3_R = """  pub(crate) fn can_match_under_dir(&self, dir: &Path) -> bool {
    self.0.iter().any(|p| p.can_match_under_dir(dir))
  }

  pub fn base_paths(&self) -> Vec<PathBuf> {"""

H4_A = "  pub fn matches_path(&self, path: &Path, path_kind: PathKind) -> bool {"
H4_R = """  pub(crate) fn can_match_under_dir(&self, dir: &Path) -> bool {
    match &self.include {
      Some(include) => include.can_match_under_dir(dir),
      None => true,
    }
  }

  pub fn matches_path(&self, path: &Path, path_kind: PathKind) -> bool {"""

H5_A = """            let should_ignore_dir =
              !opt_out_ignore && self.is_ignored_dir(&path);"""
H5_R = """            let should_ignore_dir = !opt_out_ignore
              && (self.is_ignored_dir(&path)
                || !file_patterns.can_match_under_dir(&path));"""

EDITS = [(MOD, H1_A, H1_R), (MOD, H2_A, H2_R), (MOD, H3_A, H3_R),
         (MOD, H4_A, H4_R), (COL, H5_A, H5_R)]

for rel, anchor, replacement in EDITS:
    p = ROOT / rel
    s = p.read_text()
    n = s.count(anchor)
    if n != 1:
        sys.exit(f"FAIL {rel}: anchor count {n}\n{anchor[:70]}")
    p.write_text(s.replace(anchor, replacement))
    print(f"ok  {rel:36} {len(anchor.splitlines())}-line anchor")

print(f"M5 applied: {len(EDITS)} edits")
