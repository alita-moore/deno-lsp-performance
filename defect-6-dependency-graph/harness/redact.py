#!/usr/bin/env python3
import re, sys

GROUPS = ("apps", "infra", "libs", "domain", "dev", "ml-serving")
pat = re.compile(r"\b(" + "|".join(GROUPS) + r")/([A-Za-z0-9._~-]+)")
names = {}

def repl(m):
    group, member = m.group(1), m.group(2)
    key = f"{group}/{member}"
    if key not in names:
        names[key] = f"{group}/member-{len([k for k in names if k.startswith(group + '/')]) + 1:02d}"
    return names[key]

for line in sys.stdin:
    sys.stdout.write(pat.sub(repl, line))
