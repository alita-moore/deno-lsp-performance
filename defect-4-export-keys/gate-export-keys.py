import sys, pathlib

ROOT = pathlib.Path(sys.argv[1])

REL = "cli/lsp/resolver.rs"
ANCHOR = "       result: &mut Self| {\n        let export_keys = dep_package_json"
REPL = ("       result: &mut Self| {\n"
        "        if std::env::var_os(\"DENO_LSP_SKIP_EXPORT_RESOLUTIONS\").is_some() {\n"
        "          return;\n"
        "        }\n"
        "        let export_keys = dep_package_json")

p = ROOT / REL
s = p.read_text()
n = s.count(ANCHOR)
if n != 1:
    sys.exit(f"FAIL {REL}: anchor occurs {n} times\n---\n{ANCHOR}---")
p.write_text(s.replace(ANCHOR, REPL, 1))
print(f"ok  {REL:24s} {len(ANCHOR.splitlines())}-line anchor")
print("export-key enumeration gated behind DENO_LSP_SKIP_EXPORT_RESOLUTIONS")
print("this is a measurement instrument, not a fix - do not merge it")
