import sys, pathlib

ROOT = pathlib.Path(sys.argv[1])

DISC = "libs/config/workspace/discovery.rs"

H1_A = """  if let Some(deno_json) = root_config_folder.deno_json()
    && let Some(workspace_config) = deno_json.to_workspace_config()?
  {
"""
H1_R = """  let mut deno_json_declares_workspace = false;
  if let Some(deno_json) = root_config_folder.deno_json()
    && let Some(workspace_config) = deno_json.to_workspace_config()?
  {
    deno_json_declares_workspace = true;
"""

H2_A = """    for (raw_member, member_dir_url) in member_dir_urls {
      if member_dir_url == root_config_file_directory_url {
        continue; // ignore self references
      }
      validate_member_url_is_descendant(&member_dir_url)?;
      let member_config_folder =
        match find_member_config_folder(&member_dir_url) {
          Ok(config_folder) => config_folder,
"""
H2_R = """    let mut ignored_npm_members: Vec<Url> = Vec::new();
    for (raw_member, member_dir_url) in member_dir_urls {
      if member_dir_url == root_config_file_directory_url {
        continue; // ignore self references
      }
      if deno_json_declares_workspace {
        if !final_members.contains_key(&new_rc(member_dir_url.clone())) {
          ignored_npm_members.push(member_dir_url);
        }
        continue;
      }
      validate_member_url_is_descendant(&member_dir_url)?;
      let member_config_folder =
        match find_member_config_folder(&member_dir_url) {
          Ok(config_folder) => config_folder,
"""

H3_A = """      // don't surface errors about duplicate members for
      // package.json workspace members
      final_members.insert(new_rc(member_dir_url), member_config_folder);
    }
  }
"""
H3_R = """      // don't surface errors about duplicate members for
      // package.json workspace members
      final_members.insert(new_rc(member_dir_url), member_config_folder);
    }
    if !ignored_npm_members.is_empty() {
      log::warn!(
        concat!(
          "The \\"workspace\\" field of the root deno.json is authoritative for ",
          "workspace membership, so these directories matched by the ",
          "\\"workspaces\\" field of package.json are not members: {}. ",
          "Add them to the root deno.json \\"workspace\\" field to include them."
        ),
        ignored_npm_members
          .iter()
          .map(|url| url.as_str())
          .collect::<Vec<_>>()
          .join(", "),
      );
    }
  }
"""

EDITS = [(DISC, H1_A, H1_R), (DISC, H2_A, H2_R), (DISC, H3_A, H3_R)]

sources = {rel: (ROOT / rel).read_text() for rel, _, _ in EDITS}

for rel, anchor, _ in EDITS:
    n = sources[rel].count(anchor)
    if n != 1:
        sys.exit(f"FAIL {rel}: anchor count {n}\n{anchor[:80]}")

for rel, anchor, replacement in EDITS:
    sources[rel] = sources[rel].replace(anchor, replacement)
    print(f"ok  {rel:36} {len(anchor.splitlines())}-line anchor")

for rel, text in sources.items():
    (ROOT / rel).write_text(text)

print(f"authoritative applied: {len(EDITS)} edits")
