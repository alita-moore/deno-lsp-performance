import { spawn } from "node:child_process";
import { appendFileSync, createWriteStream, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const need = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} must be set`);
  return v;
};

const args = process.argv.slice(2);
const root = args.shift();
if (!root) throw new Error("usage: probe6.mjs <root> [--enable <path>]... [--open <file>]...");

const enablePaths = [];
const opens = [];
let enableAll = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--enable") enablePaths.push(args[++i]);
  else if (args[i] === "--open") opens.push(args[++i]);
  else if (args[i] === "--enable-all") enableAll = true;
  else throw new Error(`unknown argument ${args[i]}`);
}
if (opens.length === 0) throw new Error("at least one --open is required");
if (!enableAll && enablePaths.length === 0) throw new Error("--enable-all or at least one --enable is required");

const denoBin = need("DENO_BIN");
const rssOut = need("RSS_OUT");
const smapsOut = need("SMAPS_OUT");
const stderrLog = need("LSP_STDERR_LOG");

const settings = {
  enable: true,
  ...(enableAll ? {} : { enablePaths }),
  lint: true,
  unstable: [],
  codeLens: {},
  suggest: {},
  inlayHints: {},
  internalDebug: true,
  tracing: { enable: true, collector: "logging", filter: "trace" },
};

const rootUri = pathToFileURL(root.endsWith("/") ? root : `${root}/`).href;
const t0 = Date.now();
const lsp = spawn(denoBin, ["lsp"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, DENO_LOG: "info" } });

const stat = () => {
  const s = readFileSync(`/proc/${lsp.pid}/status`, "utf8");
  const g = (k) => Number(/(?:^|\n)\s*VmRSS:\s+(\d+)/.exec(s)?.[1] ?? 0);
  return Math.round(g() / 1024);
};

let phase = "start";
let peak = 0;
writeFileSync(rssOut, "ms\trssMB\tphase\n");
const sampler = setInterval(() => {
  try {
    const mb = stat();
    if (mb > peak) peak = mb;
    appendFileSync(rssOut, `${Date.now() - t0}\t${mb}\t${phase}\n`);
    if (mb > Number(process.env.MAX_RSS_MB ?? 14000)) {
      console.log(`  ABORT: rss ${mb} MB exceeded MAX_RSS_MB in phase ${phase}`);
      clearInterval(sampler);
      lsp.kill("SIGKILL");
      process.exit(3);
    }
  } catch { clearInterval(sampler); }
}, 500);

const errOut = createWriteStream(stderrLog);
let errBuf = "";
lsp.stderr.on("data", (c) => {
  errBuf += c.toString();
  const lines = errBuf.split("\n");
  errBuf = lines.pop();
  for (const l of lines) errOut.write(`${String(Date.now() - t0).padStart(7)} ${l}\n`);
});

let buf = Buffer.alloc(0);
const pending = new Map();
const diagnosticsFor = new Map();
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
      write({
        jsonrpc: "2.0",
        id: msg.id,
        result: msg.method === "workspace/configuration" ? Array.from({ length: n }, () => settings) : null,
      });
      served += 1;
      continue;
    }
    if (msg.method === "textDocument/publishDiagnostics") {
      const u = msg.params.uri;
      diagnosticsFor.set(u, (diagnosticsFor.get(u) ?? 0) + 1);
      const w = diagWaiters.get(u);
      if (w && diagnosticsFor.get(u) >= w.n) { diagWaiters.delete(u); w.settle(); }
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const e = pending.get(msg.id);
      pending.delete(msg.id);
      e.settle({ ms: Date.now() - e.t, msg });
    }
  }
});

const diagWaiters = new Map();
const send = (request) => {
  const i = id++;
  write({ jsonrpc: "2.0", id: i, ...request });
  return new Promise((settle) => pending.set(i, { settle, t: Date.now() }));
};
const notify = (method, params) => write({ jsonrpc: "2.0", method, params });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mark = (label) => { phase = label; console.log(`${String(Date.now() - t0).padStart(7)} ms  phase=${label}  rss=${stat()} MB`); };

const heapDump = async (label) => {
  if (!process.env.HEAPLOG_OUT) return;
  process.kill(lsp.pid, "SIGUSR1");
  await sleep(Number(process.env.HEAPLOG_WAIT_MS ?? 20000));
  const src = `${process.env.HEAPLOG_OUT}.${lsp.pid}`;
  writeFileSync(`${process.env.HEAPLOG_OUT}.${label}`, readFileSync(src));
  console.log(`  heap dump ${label}: ${readFileSync(src).length} bytes`);
};

const smaps = () => {
  const rollup = readFileSync(`/proc/${lsp.pid}/smaps_rollup`, "utf8");
  const raw = readFileSync(`/proc/${lsp.pid}/smaps`, "utf8");
  const entries = [];
  let cur = null;
  for (const line of raw.split("\n")) {
    const hm = /^([0-9a-f]+)-([0-9a-f]+) (\S+) \S+ \S+ \S+\s*(.*)$/.exec(line);
    if (hm) {
      cur = { start: BigInt(`0x${hm[1]}`), end: BigInt(`0x${hm[2]}`), perms: hm[3], name: hm[4] || "[anon]", rss: 0 };
      entries.push(cur);
      continue;
    }
    const rm = /^Rss:\s+(\d+) kB/.exec(line);
    if (rm && cur) cur.rss = Number(rm[1]);
  }
  entries.sort((a, b) => b.rss - a.rss);
  const lines = [rollup, "", "top mappings by Rss", "vsizeKB\trssKB\tperms\tname"];
  for (const e of entries.slice(0, 40)) {
    lines.push(`${Number(e.end - e.start) / 1024}\t${e.rss}\t${e.perms}\t${e.name}`);
  }
  const byVsize = [...entries].sort((a, b) => Number(b.end - b.start) - Number(a.end - a.start));
  lines.push("", "top mappings by virtual size", "vsizeKB\trssKB\tperms\tname");
  for (const e of byVsize.slice(0, 15)) {
    lines.push(`${Number(e.end - e.start) / 1024}\t${e.rss}\t${e.perms}\t${e.name}`);
  }
  const byName = new Map();
  for (const e of entries) byName.set(e.name, (byName.get(e.name) ?? 0) + e.rss);
  lines.push("", "rss by mapping name", "rssKB\tname");
  for (const [n, r] of [...byName].sort((a, b) => b[1] - a[1]).slice(0, 25)) lines.push(`${r}\t${n}`);
  writeFileSync(smapsOut, lines.join("\n"));
};

mark("initialize");
const init = await send({
  method: "initialize",
  params: {
    processId: process.pid,
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: "probe" }],
    capabilities: {
      textDocument: { documentSymbol: {}, definition: {}, publishDiagnostics: {}, synchronization: {} },
      workspace: { configuration: true, didChangeConfiguration: {}, workspaceFolders: true },
    },
    initializationOptions: settings,
  },
});
console.log(`  initialize ${init.ms} ms`);
notify("initialized", {});
notify("workspace/didChangeConfiguration", { settings: { deno: settings } });
mark("config");
await sleep(Number(process.env.CONFIG_WAIT_MS ?? 20000));
mark("config-done");
await heapDump("config");


const results = [];
for (const target of opens) {
  const uri = pathToFileURL(target).href;
  const text = readFileSync(target, "utf8");
  mark(`open:${target.split("/").slice(-2).join("/")}`);
  const tOpen = Date.now();
  const waitDiag = new Promise((settle) => diagWaiters.set(uri, { settle, n: (diagnosticsFor.get(uri) ?? 0) + Number(process.env.DIAG_PUBLISHES ?? 1) }));
  notify("textDocument/didOpen", { textDocument: { uri, languageId: "typescript", version: 1, text } });
  const ds = await send({ method: "textDocument/documentSymbol", params: { textDocument: { uri } } });
  const def = await send({
    method: "textDocument/definition",
    params: { textDocument: { uri }, position: { line: 0, character: 13 } },
  });
  mark(`diag:${target.split("/").slice(-2).join("/")}`);
  const diagMs = await Promise.race([
    waitDiag.then(() => Date.now() - tOpen),
    sleep(Number(process.env.DIAG_TIMEOUT_MS ?? 240000)).then(() => -1),
  ]);
  results.push({ target, documentSymbol: ds.ms, definition: def.ms, diagnosticsMs: diagMs, rss: stat() });
  console.log(`  ${target}  documentSymbol=${ds.ms} ms  definition=${def.ms} ms  diagnostics=${diagMs} ms  rss=${stat()} MB`);
}

const requestCount = Number(process.env.REQUEST_COUNT ?? 0);
if (requestCount > 0) {
  const uri = pathToFileURL(opens[opens.length - 1]).href;
  const concurrency = Number(process.env.REQUEST_CONCURRENCY ?? 1);
  mark(`requests:0`);
  const rssBefore = stat();
  const tReq = Date.now();
  for (let done = 0; done < requestCount; done += concurrency) {
    const batch = [];
    for (let k = 0; k < concurrency && done + k < requestCount; k++) {
      batch.push(send({
        method: "textDocument/definition",
        params: { textDocument: { uri }, position: { line: 0, character: 13 } },
      }));
    }
    await Promise.all(batch);
    if ((done / concurrency) % 10 === 0) {
      phase = `requests:${done + batch.length}`;
      console.log(`  after ${done + batch.length} requests  rss=${stat()} MB`);
    }
  }
  console.log(`  ${requestCount} requests at concurrency ${concurrency} in ${Date.now() - tReq} ms`);
  console.log(`  rss before requests ${rssBefore} MB, after ${stat()} MB`);
  await heapDump("requests");
}

mark("settle");
await sleep(5000);
mark("peak");
smaps();
await heapDump("peak");

const perf = await send({ method: "deno/performance" });
const rows = (perf.msg.result?.averages ?? [])
  .map((r) => ({ name: r.name, count: r.count, totalMs: r.averageDuration * r.count }))
  .sort((a, b) => b.totalMs - a.totalMs)
  .slice(0, 30);
console.log("  --- deno/performance (top 30 by total ms) ---");
for (const a of rows) console.log(`    ${String(Math.round(a.totalMs)).padStart(8)} ms  x${String(a.count).padStart(7)}  ${a.name}`);
console.log(`  config requests served  ${served}`);
console.log(`  final rss               ${stat()} MB`);
console.log(`  peak rss                ${peak} MB`);
console.log(`  lsp pid                 ${lsp.pid}`);
clearInterval(sampler);
lsp.kill("SIGKILL");
process.exit(0);
