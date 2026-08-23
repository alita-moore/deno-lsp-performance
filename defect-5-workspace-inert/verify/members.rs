use std::path::PathBuf;

use deno_config::workspace::WorkspaceDirectory;
use deno_config::workspace::WorkspaceDiscoverOptions;
use deno_config::workspace::WorkspaceDiscoverStart;

struct Stderr;

impl log::Log for Stderr {
  fn enabled(&self, _: &log::Metadata) -> bool {
    true
  }
  fn log(&self, record: &log::Record) {
    println!("LOG {} {}", record.level(), record.args());
  }
  fn flush(&self) {}
}

static LOGGER: Stderr = Stderr;

fn main() {
  log::set_logger(&LOGGER).unwrap();
  log::set_max_level(log::LevelFilter::Trace);
  let sys = sys_traits::impls::RealSys;
  let start: Vec<PathBuf> = std::env::args().skip(1).map(PathBuf::from).collect();
  let opts = WorkspaceDiscoverOptions {
    deno_json_cache: None,
    pkg_json_cache: None,
    workspace_cache: None,
    additional_config_file_names: &[],
    discover_pkg_json: true,
    maybe_vendor_override: None,
  };
  match WorkspaceDirectory::discover(
    &sys,
    WorkspaceDiscoverStart::Paths(&start),
    &opts,
  ) {
    Ok(dir) => {
      println!("ROOT {}", dir.workspace.root_dir_path().display());
      let mut members: Vec<String> = dir
        .workspace
        .config_folders()
        .keys()
        .map(|url| url.to_string())
        .collect();
      members.sort();
      for member in members {
        println!("MEMBER {member}");
      }
    }
    Err(err) => println!("ERROR {err}"),
  }
}
