import os, re, subprocess, sys

DENO = os.environ.get("DENO_BIN", "deno")
ANSI = re.compile(r"\x1b\[[0-9;]*m")
HEAD = re.compile(r"^Available tasks \((.+)\):$")

def member_set(root):
    p = subprocess.run([DENO, "task", "-r"], cwd=str(root), capture_output=True, text=True)
    out = ANSI.sub("", p.stdout)
    err = ANSI.sub("", p.stderr)
    names = [m.group(1) for line in out.splitlines() for m in [HEAD.match(line.strip())] if m]
    return {"names": names, "code": p.returncode, "stderr": err.strip(), "stdout": out.strip()}

if __name__ == "__main__":
    r = member_set(sys.argv[1])
    print(r["code"], r["names"])
    if r["stderr"]:
        print(r["stderr"])
