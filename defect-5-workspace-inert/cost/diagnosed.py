#!/usr/bin/env python3
import json, pathlib, statistics, sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import sweep
from build import build
from members import member_set

DECLARED = 2


def workspace(arm, n):
    rel = [f"packages/p{i:03d}" for i in range(n)]
    members = [dict(rel=r, name="@w/" + r.split("/")[1], pkg=(i < DECLARED))
               for i, r in enumerate(rel)]
    npm = ["packages/*"] if arm == "diagnosed" else None
    return build(sweep.BUILD / f"{arm}-{n:04d}", rel[:DECLARED], npm, members,
                 deps=sweep.DEPS, sources=sweep.SOURCES)


if __name__ == "__main__":
    counts = [int(a) for a in sys.argv[1:]] or [128, 192]
    rows = []
    for n in counts:
        for arm in ("diagnosed", "diagnosed-base"):
            root = workspace(arm, n)
            ms = member_set(root)
            nmem = len([x for x in ms["names"] if x != "root"])
            for rep in range(sweep.REPS):
                r = sweep.probe(root)
                row = dict(arm=arm, dirs=n, members=nmem, rep=rep, **r)
                rows.append(row)
                print(json.dumps({k: v for k, v in row.items() if k != "span_counts"}), flush=True)
    (HERE / "diagnosed.json").write_text(json.dumps(rows, indent=2) + "\n")
