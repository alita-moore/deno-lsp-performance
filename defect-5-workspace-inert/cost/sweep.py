#!/usr/bin/env python3
import glob, json, os, pathlib, re, subprocess, sys, time

HERE = pathlib.Path(__file__).resolve().parent
ROOTDIR = HERE.parent
sys.path.insert(0, str(ROOTDIR))
from build import build
from members import member_set

HARNESS = ROOTDIR.parent / "harness"
ANSI = re.compile(r"\x1b\[[0-9;]*m")
UNIT = {"s": 1000.0, "ms": 1.0, "µs": 0.001}
SPANS = ["did_change_configuration", "refresh_config_tree",
         "refresh_compiler_options_resolver", "initialized"]


def env_path(name):
    v = os.environ.get(name)
    if not v:
        raise SystemExit(f"{name} must be set")
    p = pathlib.Path(v).expanduser().resolve()
    if not p.is_file():
        raise SystemExit(f"not a file: {p}")
    return p


DENO_BIN = env_path("DENO_BIN")
DIRLOG_SO = env_path("DIRLOG_SO")
BUILD = pathlib.Path(os.environ.get("SWEEP_BUILD_ROOT", "/var/tmp/defect5-sweep")).resolve()
LOGS = BUILD / "_logs"
DIRLOG = LOGS / "opendir.txt"
STDERR_LOG = LOGS / "lsp-stderr.log"
SHIM = BUILD / "_shim"

DEPS = int(os.environ.get("SWEEP_DEPS", "60"))
SOURCES = int(os.environ.get("SWEEP_SOURCES", "10"))
REPS = int(os.environ.get("SWEEP_REPS", "2"))
DECLARED = 2
COUNTS = [8, 16, 32, 64, 128, 192]
ARMS = ["union", "authoritative", "declared-all"]


def workspace(arm, n, sources=None):
    rel = [f"packages/p{i:03d}" for i in range(n)]
    members = [dict(rel=r, name="@w/" + r.split("/")[1]) for r in rel]
    deno, npm = {
        "union": (rel[:DECLARED], ["packages/*"]),
        "authoritative": (rel[:DECLARED], None),
        "declared-all": (rel, None),
    }[arm]
    src = SOURCES if sources is None else sources
    return build(BUILD / f"{arm}-{n:04d}-s{src:03d}", deno, npm, members,
                 deps=DEPS, sources=src)


def spans(path):
    tot = {n: 0.0 for n in SPANS}
    cnt = {n: 0 for n in SPANS}
    pats = {n: re.compile(rf"(?:^|[ :]){re.escape(n)}: .*?time\.busy=([0-9.]+)(s|ms|µs)") for n in SPANS}
    with open(path, errors="ignore") as fh:
        for line in fh:
            clean = ANSI.sub("", line)
            for n, pat in pats.items():
                m = pat.search(clean)
                if m:
                    tot[n] += float(m.group(1)) * UNIT[m.group(2)]
                    cnt[n] += 1
    return {n: round(tot[n]) for n in SPANS}, cnt


def probe(root):
    LOGS.mkdir(parents=True, exist_ok=True)
    for f in glob.glob(f"{DIRLOG}.*"):
        os.remove(f)
    SHIM.mkdir(parents=True, exist_ok=True)
    link = SHIM / "deno"
    if link.is_symlink() or link.exists():
        link.unlink()
    link.symlink_to(DENO_BIN)
    env = dict(os.environ, DIRLOG_OUT=str(DIRLOG), LD_PRELOAD=str(DIRLOG_SO),
               PATH=f"{SHIM}:{os.environ['PATH']}", LSP_STDERR_LOG=str(STDERR_LOG))
    entry = root / "packages" / "p000" / "mod.ts"
    t0 = time.time()
    p = subprocess.run(["taskset", "-c", "0-2", "node", str(HARNESS / "lsp-probe.mjs"), str(root), str(entry)],
                       env=env, capture_output=True, text=True, timeout=900)
    wall = int((time.time() - t0) * 1000)
    opens = []
    for f in glob.glob(f"{DIRLOG}.*"):
        opens += [l.split(" ", 1)[1].strip() for l in open(f, errors="ignore") if " " in l]
    out = p.stdout
    def grab(k):
        m = re.search(rf"{k}\s+(\d+) ms", out)
        return int(m.group(1)) if m else None
    sp, sc = spans(STDERR_LOG)
    return dict(wall=wall, opendir=len(opens),
                member_opens=sum(1 for o in opens if "/packages/p" in o),
                documentSymbol=grab("documentSymbol"), definition=grab("definition"),
                rss=int(re.search(r"peak rss\s+(\d+) MB", out).group(1)),
                spans=sp, span_counts=sc)


def run(arms, counts, sources=None):
    rows = []
    for n in counts:
        for arm in arms:
            root = workspace(arm, n, sources)
            ms = member_set(root)
            nmem = len([x for x in ms["names"] if x != "root"])
            for rep in range(REPS):
                r = probe(root)
                row = dict(arm=arm, dirs=n, sources=SOURCES if sources is None else sources,
                           members=nmem, rep=rep, **r)
                rows.append(row)
                print(json.dumps({k: v for k, v in row.items() if k != "span_counts"}), flush=True)
    return rows


if __name__ == "__main__":
    args = sys.argv[1:]
    counts = [int(a) for a in args if a.isdigit()] or COUNTS
    arms = [a for a in args if not a.isdigit()] or ARMS
    rows = run(arms, counts)
    (HERE / "results.json").write_text(json.dumps(rows, indent=2) + "\n")
