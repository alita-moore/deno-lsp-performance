import { spawn } from "node:child_process";
import { createWriteStream, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const stderrLogPath = () => {
  const p = process.env.LSP_STDERR_LOG;
  if (!p) throw new Error("LSP_STDERR_LOG must name the file deno lsp's stderr is written to");
  return p;
};

const rss = (pid) =>
  Math.round(Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))[1]) / 1024);

export async function probe({ root, target, settings }) {
  const uri = pathToFileURL(target).href;
  const text = readFileSync(target, "utf8");
  const rootUri = pathToFileURL(root).href;
  const t0 = Date.now();

  const lsp = spawn("deno", ["lsp"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, DENO_LOG: "info" } });
  const errOut = createWriteStream(stderrLogPath());
  let errBuf = "";
  lsp.stderr.on("data", (chunk) => {
    errBuf += chunk.toString();
    const lines = errBuf.split("\n");
    errBuf = lines.pop();
    for (const l of lines) errOut.write(`${String(Date.now() - t0).padStart(7)} ${l}\n`);
  });

  let buf = Buffer.alloc(0);
  const pending = new Map();
  let id = 1;
  let served = 0;

  const write = (obj) => {
    const s = JSON.stringify(obj);
    lsp.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`);
  };

  lsp.stdout.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const h = buf.indexOf("\r\n\r\n");
      if (h < 0) return;
      const m = /Content-Length: (\d+)/i.exec(buf.slice(0, h).toString());
      if (!m) return;
      const len = Number(m[1]);
      const start = h + 4;
      if (buf.length < start + len) return;
      const msg = JSON.parse(buf.slice(start, start + len).toString());
      buf = buf.slice(start + len);

      if (msg.id !== undefined && msg.method !== undefined) {
        const n = (msg.params?.items ?? []).length || 1;
        const result = msg.method === "workspace/configuration"
          ? Array.from({ length: n }, () => settings)
          : null;
        write({ jsonrpc: "2.0", id: msg.id, result });
        served += 1;
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const entry = pending.get(msg.id);
        pending.delete(msg.id);
        entry.settle({ ms: Date.now() - entry.t, msg });
      }
    }
  });

  const send = (request) => {
    const i = id++;
    write({ jsonrpc: "2.0", id: i, ...request });
    return new Promise((settle) => pending.set(i, { settle, t: Date.now() }));
  };
  const notify = (method, params) => write({ jsonrpc: "2.0", method, params });
  const row = (label, ms) => console.log(`  ${label.padEnd(24)} ${String(ms).padStart(7)} ms   rss=${rss(lsp.pid)} MB`);

  const initialize = await send({
    method: "initialize",
    params: {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: "probe" }],
      capabilities: {
        textDocument: { documentSymbol: {}, definition: {} },
        workspace: { configuration: true, didChangeConfiguration: {} },
      },
      initializationOptions: settings,
    },
  });
  row("initialize", initialize.ms);
  notify("initialized", {});
  notify("workspace/didChangeConfiguration", { settings: { deno: settings } });
  await new Promise((r) => setTimeout(r, 5000));
  console.log(`  after config walk                  rss=${rss(lsp.pid)} MB`);

  notify("textDocument/didOpen", { textDocument: { uri, languageId: "typescript", version: 1, text } });

  row("documentSymbol", (await send({ method: "textDocument/documentSymbol", params: { textDocument: { uri } } })).ms);
  row("definition", (await send({
    method: "textDocument/definition",
    params: { textDocument: { uri }, position: { line: 0, character: 13 } },
  })).ms);
  row("inlayHint", (await send({
    method: "textDocument/inlayHint",
    params: {
      textDocument: { uri },
      range: { start: { line: 0, character: 0 }, end: { line: Math.max(0, text.split("\n").length - 1), character: 0 } },
    },
  })).ms);

  const perf = await send({ method: "deno/performance" });
  const rows = perf.msg.result.averages
    .map((r) => ({ name: r.name, count: r.count, totalMs: r.averageDuration * r.count }))
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, 25);
  console.log("  --- deno/performance (top 25 by total ms) ---");
  for (const a of rows) console.log(`    ${String(Math.round(a.totalMs)).padStart(8)} ms  x${String(a.count).padStart(6)}  ${a.name}`);
  console.log(`  config requests served             ${served}`);
  console.log(`  peak rss                           ${rss(lsp.pid)} MB`);
  lsp.kill();
  process.exit(0);
}

export const tracing = { enable: true, collector: "logging", filter: "trace" };
