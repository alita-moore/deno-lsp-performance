#!/usr/bin/env python3
import glob, os, re, subprocess, sys

if len(sys.argv) < 3:
    raise SystemExit("usage: heapsym.py <heaplog-glob> <deno-binary> [top]")
pattern, binary = sys.argv[1], sys.argv[2]
top = int(sys.argv[3]) if len(sys.argv) > 3 else 12

best = None
for path in glob.glob(pattern):
    if os.path.getsize(path) == 0:
        continue
    if best is None or os.path.getsize(path) > os.path.getsize(best):
        best = path
if best is None:
    raise SystemExit(f"no non-empty capture matched {pattern}")

base = None
interval = 1 << 20
live_big = live_samples = 0
entries, cur = [], None
for line in open(best, errors="ignore"):
    m = re.match(r"^EXEMAP ([0-9a-f]+)-", line)
    if m:
        base = int(m.group(1), 16)
        continue
    m = re.match(r"^INTERVAL (\d+)", line)
    if m:
        interval = int(m.group(1))
        continue
    m = re.match(r"^LIVEBIG (\d+)", line)
    if m:
        live_big = int(m.group(1))
        continue
    m = re.match(r"^LIVESAMPLES (\d+)", line)
    if m:
        live_samples = int(m.group(1))
        continue
    m = re.match(r"^STACK bigbytes=(\d+) bigcount=(\d+) samples=(\d+)", line)
    if m:
        cur = {"big": int(m.group(1)), "count": int(m.group(2)), "samples": int(m.group(3)), "frames": []}
        entries.append(cur)
        continue
    if line.startswith("  0x") and cur is not None:
        cur["frames"].append(int(line.strip(), 16))

if base is None:
    raise SystemExit(f"{best} has no EXEMAP line")

for e in entries:
    e["est"] = e["big"] + e["samples"] * interval

print(f"capture        {best}")
print(f"exe base       0x{base:x}")
print(f"live large     {live_big/1e6:.1f} MB in allocations >= threshold, recorded exactly")
print(f"live sampled   {live_samples} samples x {interval/1e6:.3f} MB = {live_samples*interval/1e6:.1f} MB estimated")
print(f"live total     {(live_big + live_samples*interval)/1e6:.1f} MB estimated")
print(f"distinct stacks {len(entries)}\n")

_all = sorted({f for e in entries for f in e["frames"] if f >= base and (f - base) < (1 << 34)})
_raw = subprocess.run(["addr2line", "-f", "-C", "-e", binary] + [f"0x{f - base:x}" for f in _all],
                      capture_output=True, text=True).stdout.strip().split("\n")
_table = {f: (_raw[2 * i].strip(), _raw[2 * i + 1].strip()) for i, f in enumerate(_all)}

def sym(frames):
    return [_table[f] for f in frames if f in _table]

total = sum(e["est"] for e in entries) or 1

attribute = os.environ.get("ATTRIBUTE")
if attribute:
    hit = [e for e in entries if any(attribute in fn for fn, _ in sym(e["frames"]))]
    bytes_ = sum(e["est"] for e in hit)
    allocs = sum(e["count"] for e in hit)
    print(f"stacks containing {attribute!r}: {len(hit)} stacks, {bytes_/1e6:.1f} MB live "
          f"({100.0*bytes_/total:.0f}% of live), {allocs} large allocations\n")

for rank, e in enumerate(sorted(entries, key=lambda x: -x["est"])[:top], 1):
    print(f"=== stack {rank}: {e['est']/1e6:.1f} MB live ({100.0*e['est']/total:.1f}%)  "
          f"{e['big']/1e6:.1f} MB in {e['count']} large allocations, {e['samples']} samples ===")
    shown = 0
    for fn, loc in sym(e["frames"]):
        if fn == "??":
            continue
        print(f"    {fn}\n        {loc}")
        shown += 1
        if shown >= 22:
            break
    print()
