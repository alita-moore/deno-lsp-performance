#!/usr/bin/env python3
import glob, json, os, re, sys, collections

if len(sys.argv) < 3:
    raise SystemExit("usage: analyze.py <arm-dir> <workspace-root>")
arm, root = sys.argv[1], os.path.realpath(sys.argv[2])

opens, dirs = [], []
for f in glob.glob(os.path.join(arm, "fslog.txt.*")):
    with open(f, errors="ignore") as fh:
        for line in fh:
            p = line.rstrip("\n").split(" ", 2)
            if len(p) != 3:
                continue
            (opens if p[1] == "F" else dirs).append((int(p[0]), p[2]))

opens.sort()
print(f"open() calls              {len(opens)}")
print(f"opendir() calls           {len(dirs)}")
distinct = {p for _, p in opens}
print(f"distinct paths opened     {len(distinct)}")

for name in ("deno.lock", "pnpm-lock.yaml", "package-lock.json", "yarn.lock", ".npmrc"):
    hits = [(t, p) for t, p in opens if os.path.basename(p) == name]
    where = collections.Counter(p for _, p in hits)
    print(f"{name:24s}  {len(hits):6d} open() calls over {len(where)} distinct paths")
    for p, c in where.most_common(5):
        print(f"    x{c:<5d} {p}")

pkg = re.compile(r"^(.*/node_modules/(?:@[^/]+/)?[^/]+)/")
packages = collections.Counter()
dts_bytes, dts_files = 0, set()
for _, p in opens:
    m = pkg.match(p)
    if m:
        packages[m.group(1)] += 1
    if p.endswith(".d.ts") or p.endswith(".d.mts") or p.endswith(".d.cts"):
        dts_files.add(p)
print(f"distinct node_modules package dirs touched   {len(packages)}")
for p in dts_files:
    try:
        dts_bytes += os.path.getsize(p)
    except OSError:
        pass
print(f"distinct .d.ts opened                        {len(dts_files)}  ({dts_bytes/1e6:.1f} MB on disk)")

members = collections.Counter()
mem = re.compile(re.escape(root) + r"/((?:apps|infra|libs|domain|dev|ml-serving)/[^/]+)/")
for _, p in opens:
    if "/node_modules/" in p:
        continue
    m = mem.match(p)
    if m:
        members[m.group(1)] += 1
print(f"workspace members with a non-node_modules file opened   {len(members)}")
for m, c in members.most_common(80):
    print(f"    x{c:<6d} {m}")

marker = os.environ.get("MARKERS")
if marker:
    for dep in marker.split(","):
        frag = f"/node_modules/{dep}/"
        hits = [p for p in distinct if frag in p]
        print(f"marker {dep:45s} {len(hits):5d} distinct files opened")
