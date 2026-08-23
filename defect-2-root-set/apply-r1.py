import sys, pathlib

ROOT = pathlib.Path(sys.argv[1])

def field(indent, existing, added):
    a = "\n" + indent + existing + "\n"
    return a, a + indent + added + "\n"

EDITS = []

EDITS.append(("libs/config/glob/collector.rs",
  "  pub fn use_gitignore(mut self) -> Self {\n    self.use_gitignore = true;\n    self\n  }\n",
  "  pub fn use_gitignore(mut self) -> Self {\n    self.use_gitignore = true;\n    self\n  }\n\n"
  "  pub fn set_use_gitignore(mut self, use_gitignore: bool) -> Self {\n"
  "    self.use_gitignore = use_gitignore;\n    self\n  }\n"))

EDITS.append(("cli/util/fs.rs",
  "  /// Whether to include paths that are specified even if they're ignored.\n"
  "  pub include_ignored_specified: bool,\n}\n",
  "  /// Whether to include paths that are specified even if they're ignored.\n"
  "  pub include_ignored_specified: bool,\n"
  "  /// Whether to skip paths excluded by the version control ignore set.\n"
  "  pub use_gitignore: bool,\n}\n"))

EDITS.append(("cli/util/fs.rs",
  "    include_ignored_specified: always_include_specified,\n  } = options;\n",
  "    include_ignored_specified: always_include_specified,\n    use_gitignore,\n  } = options;\n"))

EDITS.append(("cli/util/fs.rs",
  "    .set_vendor_folder(vendor_folder)\n"
  "    .collect_file_patterns(&CliSys::default(), &file_patterns);\n",
  "    .set_vendor_folder(vendor_folder)\n"
  "    .set_use_gitignore(use_gitignore)\n"
  "    .collect_file_patterns(&CliSys::default(), &file_patterns);\n"))

EDITS.append(("cli/lsp/compiler_options.rs",
  *field(" " * 12, "include_ignored_specified: true,", "use_gitignore: true,")))

EDITS.append(("cli/graph_container.rs",
  *field(" " * 8, "include_ignored_specified: options.include_ignored_specified,", "use_gitignore: false,")))

for indent in (6, 8, 16):
    EDITS.append(("cli/tools/test/mod.rs",
      *field(" " * indent, "include_ignored_specified: false,", "use_gitignore: false,")))

EDITS.append(("cli/tools/doc.rs",
  *field(" " * 10, "include_ignored_specified: false,", "use_gitignore: false,")))

for indent in (10, 16):
    EDITS.append(("cli/tools/bench/mod.rs",
      *field(" " * indent, "include_ignored_specified: false,", "use_gitignore: false,")))

TEST_TAIL = "        },\n        vendor_folder: None,\n        include_ignored_specified: false,\n"
TEST_ADD = TEST_TAIL + "        use_gitignore: false,\n"

EDITS.append(("cli/util/fs.rs",
  "          )]),\n" + TEST_TAIL,
  "          )]),\n" + TEST_ADD))

EDITS.append(("cli/util/fs.rs",
  "          exclude: Default::default(),\n" + TEST_TAIL,
  "          exclude: Default::default(),\n" + TEST_ADD))

for rel, anchor, repl in EDITS:
    p = ROOT / rel
    s = p.read_text()
    n = s.count(anchor)
    if n != 1:
        sys.exit(f"FAIL {rel}: anchor occurs {n} times\n---\n{anchor}---")
    p.write_text(s.replace(anchor, repl, 1))
    print(f"ok  {rel:34s} {len(anchor.splitlines())}-line anchor")
print("R1 applied: %d edits" % len(EDITS))
