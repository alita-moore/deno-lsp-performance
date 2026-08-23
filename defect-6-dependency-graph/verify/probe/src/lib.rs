use deno_resolver::npm::managed::NpmResolutionCellRc;

pub fn probe(source: &NpmResolutionCellRc, destination: &NpmResolutionCellRc) {
  destination.set_snapshot_rc(source.snapshot_rc());
}
