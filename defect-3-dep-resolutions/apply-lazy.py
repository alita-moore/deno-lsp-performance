import sys, pathlib

ROOT = pathlib.Path(sys.argv[1])

EDITS = []

EDITS.append(("cli/lsp/resolver.rs",
  "  configured_dep_resolutions: Arc<ConfiguredDepResolutions>,\n",
  "  configured_dep_resolutions: Arc<OnceLock<Arc<ConfiguredDepResolutions>>>,\n"))

EDITS.append(("cli/lsp/resolver.rs",
  "    let configured_dep_resolutions = (|| {\n"
  "      let npm_pkg_req_resolver = npm_pkg_req_resolver.as_ref()?;\n"
  "      Some(Arc::new(ConfiguredDepResolutions::new(\n"
  "        workspace_resolver.clone(),\n"
  "        config_data.and_then(|d| d.maybe_pkg_json().map(|p| p.as_ref())),\n"
  "        npm_pkg_req_resolver,\n"
  "        &pkg_json_resolver,\n"
  "      )))\n"
  "    })()\n"
  "    .unwrap_or_default();\n",
  "    let configured_dep_resolutions = Arc::new(OnceLock::new());\n"))

EDITS.append(("cli/lsp/resolver.rs",
  "      .configured_dep_resolutions\n      .dep_key_from_resolution(specifier, referrer)",
  "      .configured_dep_resolutions()\n      .dep_key_from_resolution(specifier, referrer)"))

EDITS.append(("cli/lsp/resolver.rs",
  "        .configured_dep_resolutions\n        .deps_by_resolution",
  "        .configured_dep_resolutions()\n        .deps_by_resolution"))

EDITS.append(("cli/lsp/resolver.rs",
  "  pub fn resource_url_to_configured_dep_key(",
  "  fn configured_dep_resolutions(&self) -> Arc<ConfiguredDepResolutions> {\n"
  "    self\n"
  "      .configured_dep_resolutions\n"
  "      .get_or_init(|| {\n"
  "        let Some(npm_pkg_req_resolver) = self.npm_pkg_req_resolver.as_ref()\n"
  "        else {\n"
  "          return Default::default();\n"
  "        };\n"
  "        Arc::new(ConfiguredDepResolutions::new(\n"
  "          self.workspace_resolver.clone(),\n"
  "          self\n"
  "            .config_data\n"
  "            .as_ref()\n"
  "            .and_then(|d| d.maybe_pkg_json().map(|p| p.as_ref())),\n"
  "          npm_pkg_req_resolver,\n"
  "          &self.pkg_json_resolver,\n"
  "        ))\n"
  "      })\n"
  "      .clone()\n"
  "  }\n\n"
  "  pub fn resource_url_to_configured_dep_key("))

EDITS.append(("cli/lsp/resolver.rs",
  "use std::sync::Arc;\n",
  "use std::sync::Arc;\nuse std::sync::OnceLock;\n"))

for rel, anchor, repl in EDITS:
    p = ROOT / rel
    s = p.read_text()
    n = s.count(anchor)
    if n != 1:
        sys.exit(f"FAIL {rel}: anchor occurs {n} times\n---\n{anchor}---")
    p.write_text(s.replace(anchor, repl, 1))
    print(f"ok  {rel:24s} {len(anchor.splitlines())}-line anchor")
print("lazy dep resolutions applied: %d edits" % len(EDITS))
