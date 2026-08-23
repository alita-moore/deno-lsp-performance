import { join, relative } from "node:path";

const under = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);

export const vcsIgnore = (fs, root) => {
  const path = join(root, ".gitignore");
  if (!fs.exists(path)) throw new Error(`no_gitignore:${root}`);
  const names = [];
  const anchored = [];
  for (const raw of fs.readFile(path).split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (line.startsWith("!")) throw new Error(`gitignore_negation_unsupported:${line}`);
    const text = line.replace(/\/+$/, "");
    if (text.includes("*") || text.includes("?"))
      throw new Error(`gitignore_glob_unsupported:${line}`);
    if (text.includes("/")) anchored.push(join(root, text));
    else names.push(text);
  }
  const ignoredBelow = (base, candidate) => {
    if (!under(candidate, base)) return false;
    const rel = relative(base, candidate);
    if (rel.length === 0) return false;
    return (
      rel.split("/").some((segment) => names.includes(segment)) ||
      anchored.some((prefix) => under(candidate, prefix) && prefix.length > base.length)
    );
  };
  return { root, ignoredBelow, ignored: (candidate) => ignoredBelow(root, candidate) };
};
