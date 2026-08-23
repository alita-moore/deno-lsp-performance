import { probe, tracing } from "./lsp-driver.mjs";

const [root, target] = process.argv.slice(2);
if (!root || !target) throw new Error("usage: node lsp-probe.mjs <workspace-root> <target-file>");

await probe({
  root,
  target,
  settings: {
    enable: true,
    lint: false,
    unstable: [],
    codeLens: {},
    suggest: {},
    inlayHints: {},
    internalDebug: true,
    tracing,
  },
});
