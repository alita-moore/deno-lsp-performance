import { probe, tracing } from "./lsp-driver.mjs";

const [root, target, ...enablePaths] = process.argv.slice(2);
if (!root || !target || enablePaths.length === 0) {
  throw new Error("usage: node lsp-probe-paths.mjs <workspace-root> <target-file> <enable-path> [<enable-path> ...]");
}

await probe({
  root,
  target,
  settings: {
    enable: true,
    enablePaths,
    lint: false,
    unstable: [],
    codeLens: {},
    suggest: {},
    inlayHints: {},
    internalDebug: true,
    tracing,
  },
});
