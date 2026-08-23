#!/usr/bin/env python3
import re, sys

ANSI = re.compile(r"\x1b\[[0-9;]*m")
UNIT = {"s": 1000.0, "ms": 1.0, "µs": 0.001}

args = sys.argv[1:]
if len(args) < 2:
    raise SystemExit("usage: spans.py <lsp-stderr-log> <span-name> [<span-name> ...]")
log, names = args[0], args[1:]

pats = {n: re.compile(rf"\b{re.escape(n)}\b.*?time\.busy=([0-9.]+)(s|ms|µs)") for n in names}
totals = {n: 0.0 for n in names}
counts = {n: 0 for n in names}

with open(log, errors="ignore") as fh:
    for line in fh:
        clean = ANSI.sub("", line)
        for n, pat in pats.items():
            m = pat.search(clean)
            if m:
                totals[n] += float(m.group(1)) * UNIT[m.group(2)]
                counts[n] += 1

for n in names:
    print(f"  {n:44} {counts[n]:6} close  {totals[n]:12.0f} ms")
