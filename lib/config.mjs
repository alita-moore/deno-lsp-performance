import { dirname, join, resolve, relative, sep } from "node:path";

export const findWorkspaceRoot = (fs, from) => {
  let dir = from;
  for (;;) {
    const candidate = join(dir, "deno.json");
    if (fs.exists(candidate) && Array.isArray(fs.readJSON(candidate).workspace)) return dir;
    const up = dirname(dir);
    if (up === dir) throw new Error(`no_workspace_root_above:${from}`);
    dir = up;
  }
};

export const workspaceMembers = (fs, root) =>
  new Set(fs.readJSON(join(root, "deno.json")).workspace.map((m) => resolve(root, String(m))));

export const relSegments = (base, path) => {
  const rel = relative(base, path);
  return rel === "" ? [] : rel.split(sep);
};
