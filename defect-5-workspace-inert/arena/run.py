#!/usr/bin/env python3
import json, os, pathlib, subprocess, sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from cases import CASES, make, arm

OUT = pathlib.Path(os.environ.get("ARENA_BUILD_ROOT", "/var/tmp/defect5-arena"))


def resolver(name):
    v = os.environ.get(name)
    if not v:
        raise SystemExit(f"{name} must name a `members` example binary; see ../verify/README.md")
    p = pathlib.Path(v).expanduser().resolve()
    if not p.is_file():
        raise SystemExit(f"not a file: {p}")
    return p


BASELINE = resolver("MEMBERS_BASELINE")
PATCHED = resolver("MEMBERS_PATCHED")


def resolve(binary, start):
    p = subprocess.run([str(binary), str(start)], capture_output=True, text=True)
    members, warns, error = [], [], None
    for line in p.stdout.splitlines():
        if line.startswith("MEMBER "):
            members.append(line[len("MEMBER "):])
        elif line.startswith("LOG WARN "):
            warns.append(line[len("LOG WARN "):])
        elif line.startswith("ERROR "):
            error = line[len("ERROR "):]
    return dict(members=sorted(members), warns=warns, error=error)


def scrub(root, text):
    if text is None:
        return None
    return text.replace(pathlib.Path(root).as_uri() + "/", "<root>/").replace(str(root) + "/", "<root>/")


def rel(root, urls):
    base = pathlib.Path(root).as_uri().rstrip("/") + "/"
    return sorted(u[len(base):].rstrip("/") or "." for u in urls if u.startswith(base))


def run():
    rows = []
    for c in CASES:
        root = make(OUT, c)
        arm(root, c["deno"], c["npm"])
        starts = ["."] + [m["rel"] for m in c["members"]]
        entry = []
        for s in starts:
            b = resolve(BASELINE, pathlib.Path(root) / s)
            p = resolve(PATCHED, pathlib.Path(root) / s)
            lost = sorted(set(b["members"]) - set(p["members"]))
            named = [u for u in lost if any(u in w for w in p["warns"])]
            detached = any("is not a member of the workspace" in w for w in p["warns"])
            verdict = "same" if not lost else (
                "diagnosed" if detached or set(named) == set(lost) else "silent")
            entry.append(dict(start=s, verdict=verdict, detached=detached,
                              baseline=rel(root, b["members"]), baseline_error=scrub(root, b["error"]),
                              patched=rel(root, p["members"]), patched_error=scrub(root, p["error"]),
                              lost=rel(root, lost), lost_named=rel(root, named),
                              warns=[scrub(root, w) for w in p["warns"]]))
        rows.append(dict(id=c["id"], title=c["title"], starts=entry))
    return rows


if __name__ == "__main__":
    rows = run()
    (HERE / "results.json").write_text(json.dumps(rows, indent=2) + "\n")
    silent = 0
    for r in rows:
        top = r["starts"][0]
        print(f"{r['id']:5} {r['title']}")
        print(f"      baseline {' '.join(top['baseline']) or top['baseline_error']}")
        print(f"      patched  {' '.join(top['patched']) or top['patched_error']}")
        for e in r["starts"]:
            if e["verdict"] == "same":
                continue
            silent += e["verdict"] == "silent"
            print(f"      start {e['start']:<20} lost {' '.join(e['lost']):<40} {e['verdict'].upper()}"
                  + ("  (parent workspace detached)" if e["detached"] else ""))
    print(f"\nsilent losses: {silent}")
