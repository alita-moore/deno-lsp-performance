#!/usr/bin/env python3
import glob, json, os, shutil, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
NOISE_DIRS = 200


def env_path(name):
    v = os.environ.get(name)
    if not v:
        raise SystemExit(f"{name} must be set")
    return os.path.abspath(os.path.expanduser(v))


DENO_BIN = env_path("DENO_BIN")
DIRLOG_SO = env_path("DIRLOG_SO")
BUILD = env_path("MATRIX_BUILD_ROOT")
for p in (DENO_BIN, DIRLOG_SO):
    if not os.path.isfile(p):
        raise SystemExit(f"not a file: {p}")

LOGS = os.path.join(BUILD, "_logs")
DIRLOG = os.path.join(LOGS, "opendir.txt")
STDERR_LOG = os.path.join(LOGS, "lsp-stderr.log")
SHIM = os.path.join(BUILD, "_shim")


def noise(path):
    for i in range(NOISE_DIRS):
        d = os.path.join(path, f"pkg{i}", "inner")
        os.makedirs(d, exist_ok=True)
        open(os.path.join(d, "mod.py"), "w").close()


def build(case):
    root = os.path.join(BUILD, case["id"])
    shutil.rmtree(root, ignore_errors=True)
    npkg = case.get("packages", 1)
    members = []
    for p in range(npkg):
        name = f"app{p}" if npkg > 1 else "app"
        members.append(name)
        src = os.path.join(root, name, "src")
        os.makedirs(src, exist_ok=True)
        open(os.path.join(src, "index.ts"), "w").write("export const x = 1;\n")
        json.dump({"name": f"@m/{name}", "exports": "./src/index.ts"},
                  open(os.path.join(root, name, "deno.json"), "w"))
        pkg = case.get("pkg_tsconfig")
        if pkg is not None:
            json.dump(pkg, open(os.path.join(root, name, "tsconfig.json"), "w"))
        if p == 0 and case.get("noise_at"):
            noise(os.path.join(root, name, case["noise_at"]))
    if case.get("noise_at_root"):
        noise(os.path.join(root, case["noise_at_root"]))
    json.dump({"workspace": members}, open(os.path.join(root, "deno.json"), "w"))
    top = dict(case.get("root_tsconfig") or {})
    top.setdefault("references", [{"path": m} for m in members])
    json.dump(top, open(os.path.join(root, "tsconfig.json"), "w"))
    return root


def measure(case, root):
    os.makedirs(LOGS, exist_ok=True)
    for f in glob.glob(f"{DIRLOG}.*"):
        os.remove(f)
    os.makedirs(SHIM, exist_ok=True)
    link = os.path.join(SHIM, "deno")
    if os.path.lexists(link):
        os.remove(link)
    os.symlink(DENO_BIN, link)

    entry = os.path.join(root, "app0" if case.get("packages", 1) > 1 else "app", "src/index.ts")
    env = dict(os.environ,
               DIRLOG_OUT=DIRLOG,
               LD_PRELOAD=DIRLOG_SO,
               PATH=f"{SHIM}:{os.environ['PATH']}",
               LSP_STDERR_LOG=STDERR_LOG,
               DENO_LSP_SKIP_EXPORT_RESOLUTIONS="1")
    t0 = time.time()
    subprocess.run(["taskset", "-c", "0-2", "node", os.path.join(HERE, "lsp-probe.mjs"), root, entry],
                   env=env, capture_output=True, timeout=300)
    wall = (time.time() - t0) * 1000

    opens = []
    for f in glob.glob(f"{DIRLOG}.*"):
        opens += [l.split(" ", 1)[1].strip() for l in open(f, errors="ignore") if " " in l]
    tree = case.get("noise_at") or case.get("noise_at_root")
    leaf = tree.split("/")[-1]
    into = sum(1 for o in opens if leaf in o)
    disk = sum(len(d) for _, d, _ in os.walk(root))
    return dict(disk=disk, opendir=len(opens), into=into, wall=int(wall))


def case(id, **kw):
    return dict(id=id, **kw)


INC_SRC = {"compilerOptions": {"composite": True}, "include": ["src"], "exclude": ["node_modules", "dist"]}
INC = lambda *inc: {"compilerOptions": {"composite": True}, "include": list(inc)}
EXC = lambda *exc: {"compilerOptions": {"composite": True}, "include": ["src"], "exclude": ["node_modules", *exc]}

CASES = []

for i, (tag, at) in enumerate([("sibling", ".venv"), ("in-src", "src/.venv"), ("deep", "src/a/b/c/.venv"),
                               ("dotcache", ".cache"), ("vendor", "vendor"), ("target", "target"),
                               ("build", "build"), ("coverage", "coverage"), ("next", ".next"),
                               ("pycache", "__pycache__")], 1):
    CASES.append(case(f"A{i:02d}-{tag}", pkg_tsconfig=INC_SRC, noise_at=at))

for i, (tag, at) in enumerate([("nm-sibling", "node_modules"), ("nm-in-src", "src/node_modules"),
                               ("nm-deep", "src/a/b/node_modules"),
                               ("nm-nested", "node_modules/.deno/x/node_modules")], 1):
    CASES.append(case(f"B{i:02d}-{tag}", pkg_tsconfig=INC_SRC, noise_at=at))

CASES += [
    case("C01-include-nm", pkg_tsconfig=INC("src", "node_modules"), noise_at="node_modules"),
    case("C02-include-nm-only", pkg_tsconfig=INC("node_modules"), noise_at="node_modules"),
    case("C03-include-venv", pkg_tsconfig=INC("src", ".venv"), noise_at=".venv"),
    case("C04-include-star", pkg_tsconfig=INC("**/*"), noise_at=".venv"),
    case("C05-include-nm-root", pkg_tsconfig=INC_SRC, root_tsconfig={"include": ["node_modules"]}, noise_at="node_modules"),
    case("C06-no-exclude-at-all", pkg_tsconfig=INC("src"), noise_at=".venv"),
    case("C07-empty-exclude", pkg_tsconfig={"compilerOptions": {"composite": True}, "include": ["src"], "exclude": []}, noise_at=".venv"),
    case("C08-exclude-src", pkg_tsconfig={"compilerOptions": {"composite": True}, "include": ["src"], "exclude": ["src"]}, noise_at=".venv"),
]

for i, (tag, exc) in enumerate([("pkg-plain", ".venv"), ("pkg-glob", "**/.venv"), ("pkg-slash", ".venv/"),
                                ("pkg-starstar", "**/.venv/**"), ("pkg-abs", "./.venv")], 1):
    CASES.append(case(f"D{i:02d}-{tag}", pkg_tsconfig=EXC(exc), noise_at=".venv"))
for i, (tag, exc) in enumerate([("root-plain", "app/.venv"), ("root-glob", "**/.venv"),
                                ("root-starstar", "**/.venv/**"), ("root-bare", ".venv")], 6):
    CASES.append(case(f"D{i:02d}-{tag}", pkg_tsconfig=INC_SRC,
                      root_tsconfig={"exclude": ["node_modules", exc]}, noise_at=".venv"))

CASES += [
    case("E01-no-pkg-tsconfig", pkg_tsconfig=None, noise_at=".venv"),
    case("E02-files-list", pkg_tsconfig={"compilerOptions": {"composite": True}, "files": ["src/index.ts"]}, noise_at=".venv"),
    case("E03-no-composite", pkg_tsconfig={"include": ["src"], "exclude": ["node_modules"]}, noise_at=".venv"),
    case("E04-no-references", pkg_tsconfig=INC_SRC, root_tsconfig={"references": [], "exclude": ["node_modules"]}, noise_at=".venv"),
    case("E05-noise-at-root", pkg_tsconfig=INC_SRC, noise_at_root=".venv"),
    case("E06-noise-root-nm", pkg_tsconfig=INC_SRC, noise_at_root="node_modules"),
]

for n in (1, 2, 5, 10, 25, 50):
    CASES.append(case(f"F{n:02d}-packages", pkg_tsconfig=INC_SRC, noise_at=".venv", packages=n))
for n in (1, 10, 50):
    CASES.append(case(f"G{n:02d}-packages-nm", pkg_tsconfig=INC_SRC, noise_at="node_modules", packages=n))

if __name__ == "__main__":
    prefixes = tuple(sys.argv[1:])
    selected = [c for c in CASES if c["id"].startswith(prefixes or ("",))]
    if not selected:
        raise SystemExit(f"no case matches {prefixes}")
    print(f"  {'case':26} {'disk':>6} {'opendir':>8} {'into_tree':>10} {'wall_ms':>8}")
    for c in selected:
        m = measure(c, build(c))
        print(f"  {c['id']:26} {m['disk']:6} {m['opendir']:8} {m['into']:10} {m['wall']:8}", flush=True)
