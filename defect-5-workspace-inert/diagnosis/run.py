#!/usr/bin/env python3
import json, os, pathlib, sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from cases import CASES, make, arm
from members import member_set

OUT = pathlib.Path(os.environ.get("ARENA_BUILD_ROOT", "/var/tmp/defect5-arena"))


def names(r):
    return [n for n in r["names"] if n != "root"]


def run():
    rows = []
    for c in CASES:
        root = make(OUT, c)
        arm(root, c["deno"], c["npm"])
        u = member_set(root)
        arm(root, c["deno"], None)
        d = member_set(root)
        arm(root, None, c["npm"])
        p = member_set(root)
        arm(root, c["deno"], c["npm"])
        rows.append(dict(id=c["id"], title=c["title"],
                         U=dict(code=u["code"], names=names(u)),
                         D=dict(code=d["code"], names=names(d)),
                         P=dict(code=p["code"], names=names(p))))
    return rows


if __name__ == "__main__":
    rows = run()
    (HERE / "results.json").write_text(json.dumps(rows, indent=2) + "\n")
    print(f"{'case':5} {'both (today)':<26} {'deno.json alone':<22} {'package.json alone':<22} inert")
    for r in rows:
        f = lambda k: ("error" if r[k]["code"] else " ".join(n.replace("@w/", "") for n in r[k]["names"]) or "-")
        inert = "yes" if r["U"] == r["P"] else "no"
        print(f"{r['id']:5} {f('U'):<26} {f('D'):<22} {f('P'):<22} {inert}")
