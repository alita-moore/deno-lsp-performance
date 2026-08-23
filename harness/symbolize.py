#!/usr/bin/env python3
"""Resolve captured opendir backtraces to source lines."""
import glob, os, re, subprocess, sys

def load(pattern):
    best, base, total = None, None, 0
    for path in glob.glob(pattern):
        text = open(path, errors="ignore").read()
        if "STACK" not in text:
            continue
        m = re.search(r"^EXEMAP ([0-9a-f]+)-", text, re.M)
        t = re.search(r"^TOTAL (\d+)", text, re.M)
        if m and (best is None or os.path.getsize(path) > os.path.getsize(best)):
            best, base, total = path, int(m.group(1), 16), int(t.group(1)) if t else 0
    if best is None:
        sys.exit(f"no capture with stacks matched {pattern}")
    return best, base, total

def stacks(path):
    out, cur = [], None
    for line in open(path, errors="ignore"):
        m = re.match(r"^STACK (\d+) ?(.*)$", line)
        if m:
            cur = {"count": int(m.group(1)), "sample": m.group(2).strip(), "frames": []}
            out.append(cur)
        elif line.startswith("  0x") and cur is not None:
            cur["frames"].append(int(line.strip(), 16))
    return sorted(out, key=lambda s: -s["count"])

def symbolize(binary, base, frames):
    offs = [f"0x{f - base:x}" for f in frames if f >= base and (f - base) < (1 << 34)]
    if not offs:
        return []
    raw = subprocess.run(["addr2line", "-f", "-C", "-e", binary] + offs,
                         capture_output=True, text=True).stdout.strip().split("\n")
    return [(raw[i].strip(), raw[i + 1].strip()) for i in range(0, len(raw) - 1, 2)]

def main():
    pattern = sys.argv[1] if len(sys.argv) > 1 else "/tmp/stacktrace.txt.*"
    binary = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), "..", "bin", "deno")
    top = int(sys.argv[3]) if len(sys.argv) > 3 else 3
    path, base, total = load(pattern)
    all_stacks = stacks(path)
    captured = sum(s["count"] for s in all_stacks)
    print(f"capture      {path}")
    print(f"exe base     0x{base:x}")
    print(f"opendir      {total} matched, {captured} attributed, {len(all_stacks)} distinct stacks\n")
    for rank, s in enumerate(all_stacks[:top], 1):
        share = 100.0 * s["count"] / captured if captured else 0.0
        print(f"=== stack {rank}: {s['count']} opens ({share:.1f}%) ===")
        print(f"    example path: {s['sample']}")
        for fn, loc in symbolize(binary, base, s["frames"]):
            if fn == "??":
                continue
            print(f"    {fn}\n        {loc}")
        print()

main()
