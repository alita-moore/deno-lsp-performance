#!/usr/bin/env python3
import os, sys, time

LIMIT = 3000
SKIP = {".git", "node_modules"}


def walk_cost(root):
    n = 0
    t = time.perf_counter()
    for _, dirnames, _ in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP]
        n += 1
        if n >= LIMIT:
            break
    return n, (time.perf_counter() - t) * 1000


roots = sys.argv[1:]
if not roots:
    raise SystemExit("usage: opendirbench.py <root> [<root> ...]")
for root in roots:
    if not os.path.isdir(root):
        raise SystemExit(f"not a directory: {root}")
    n, ms = walk_cost(root)
    print(f"  {root:60} {n:6} dirs  {ms:9.0f} ms  {ms / n:7.3f} ms/dir", flush=True)
