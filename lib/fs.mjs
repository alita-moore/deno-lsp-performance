import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";

export const realFS = () => ({
  readdir: (dir) =>
    readdirSync(dir, { withFileTypes: true }).map((e) => ({
      name: e.name,
      dir: e.isDirectory(),
    })),
  isDirectory: (path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
  exists: (path) => existsSync(path),
  readJSON: (path) => JSON.parse(readFileSync(path, "utf8")),
  readFile: (path) => readFileSync(path, "utf8"),
});

export const memFS = (nodes) => ({
  readdir: (dir) => {
    const node = nodes.get(dir);
    if (node === undefined) throw new Error(`enoent:${dir}`);
    return node.children.map((name) => ({
      name,
      dir: nodes.has(`${dir}/${name}`) && nodes.get(`${dir}/${name}`).children !== undefined,
    }));
  },
  isDirectory: (path) => {
    const node = nodes.get(path);
    return node !== undefined && node.children !== undefined;
  },
  exists: (path) => nodes.has(path),
  readJSON: (path) => {
    const node = nodes.get(path);
    if (node === undefined) throw new Error(`enoent:${path}`);
    return JSON.parse(node.content);
  },
  readFile: (path) => {
    const node = nodes.get(path);
    if (node === undefined) throw new Error(`enoent:${path}`);
    return node.content;
  },
});
