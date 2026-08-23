import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const framed = (obj) => {
  const body = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
};

export const openSession = ({ bin, root, settings }) => {
  const lsp = spawn(bin, ["lsp"], { stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  const diagnostics = new Map();
  let buf = Buffer.alloc(0);
  let id = 1;

  lsp.stderr.resume();
  lsp.stdout.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const head = buf.indexOf("\r\n\r\n");
      if (head < 0) return;
      const match = /Content-Length: (\d+)/i.exec(buf.slice(0, head).toString());
      if (match === null) throw new Error("no_content_length_header");
      const start = head + 4;
      const length = Number(match[1]);
      if (buf.length < start + length) return;
      const message = JSON.parse(buf.slice(start, start + length).toString());
      buf = buf.slice(start + length);
      if (message.method === "textDocument/publishDiagnostics") {
        diagnostics.set(message.params.uri, message.params.diagnostics);
        continue;
      }
      if (message.id !== undefined && message.method !== undefined) {
        const count = (message.params?.items ?? []).length || 1;
        const result =
          message.method === "workspace/configuration"
            ? Array.from({ length: count }, () => settings)
            : null;
        lsp.stdin.write(framed({ jsonrpc: "2.0", id: message.id, result }));
        continue;
      }
      if (message.id !== undefined && pending.has(message.id)) {
        const settle = pending.get(message.id);
        pending.delete(message.id);
        settle(message.result);
      }
    }
  });

  const request = (method, params) => {
    const at = id++;
    lsp.stdin.write(framed({ jsonrpc: "2.0", id: at, method, params }));
    return new Promise((settle) => pending.set(at, settle));
  };
  const notify = (method, params) => lsp.stdin.write(framed({ jsonrpc: "2.0", method, params }));
  const rootUri = pathToFileURL(root).href;

  return {
    diagnostics,
    request,
    notify,
    close: () => lsp.kill(),
    start: async () => {
      await request("initialize", {
        processId: process.pid,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: "probe" }],
        capabilities: {
          textDocument: {
            documentSymbol: {},
            definition: {},
            hover: { contentFormat: ["plaintext", "markdown"] },
            completion: { completionItem: { snippetSupport: false } },
            publishDiagnostics: {},
          },
          workspace: { configuration: true, didChangeConfiguration: {} },
        },
        initializationOptions: settings,
      });
      notify("initialized", {});
      notify("workspace/didChangeConfiguration", { settings: { deno: settings } });
      await new Promise((settle) => setTimeout(settle, Number(process.env.SETTLE_MS ?? 4000)));
    },
    openFile: (path) => {
      const uri = pathToFileURL(path).href;
      notify("textDocument/didOpen", {
        textDocument: { uri, languageId: "typescript", version: 1, text: readFileSync(path, "utf8") },
      });
      return uri;
    },
  };
};

export const SETTINGS = Object.freeze({
  enable: true,
  lint: false,
  unstable: [],
  codeLens: {},
  suggest: { autoImports: true, imports: { autoDiscover: false, hosts: {} } },
  inlayHints: {},
});
