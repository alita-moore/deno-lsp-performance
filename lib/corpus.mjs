import { join, dirname } from "node:path";

const corpusOf = (root, files) => {
  const covered = new Set();
  for (const file of files) {
    let dir = dirname(file);
    for (;;) {
      if (covered.has(dir)) break;
      covered.add(dir);
      if (dir === root) break;
      dir = dirname(dir);
    }
  }
  return {
    has: (file) => files.has(file),
    covers: (dir) => covered.has(dir),
    size: files.size,
  };
};

export const everythingCorpus = (fs, root) => {
  const files = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdir(dir)) {
      const path = join(dir, entry.name);
      if (entry.dir) walk(path);
      else files.add(path);
    }
  };
  walk(root);
  return corpusOf(root, files);
};

export const listCorpus = (root, files) => corpusOf(root, new Set(files));
