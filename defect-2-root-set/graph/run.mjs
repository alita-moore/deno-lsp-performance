import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openSession, SETTINGS } from "./client.mjs";
import { ARMS, CASES, buildCase } from "./cases.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const BIN = process.env.DENO_BIN ?? resolve(here, "../../bin/deno");

const textOf = (hover) => {
  const contents = hover?.contents;
  if (contents === undefined || contents === null) return "";
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) return contents.map((part) => part.value ?? part).join(" ");
  return contents.value ?? "";
};

const typeProbe = async (session, uri) => {
  const hover = await session.request("textDocument/hover", {
    textDocument: { uri },
    position: { line: 1, character: 13 },
  });
  const definition = await session.request("textDocument/definition", {
    textDocument: { uri },
    position: { line: 1, character: 21 },
  });
  const targets = definition === null ? [] : [definition].flat();
  return {
    signal: /"recovered"/.test(textOf(hover)) ? "typed" : "untyped",
    detail: targets.length === 0 ? "no definition" : targets[0].uri ?? targets[0].targetUri,
  };
};

const completionProbe = async (session, uri) => {
  const result = await session.request("textDocument/completion", {
    textDocument: { uri },
    position: { line: 0, character: 28 },
    context: { triggerKind: 1 },
  });
  const items = result === null ? [] : (result.items ?? result);
  const hit = items.find((item) => item.label === "orphanMarker");
  return {
    signal: hit === undefined ? "absent" : "offered",
    detail: `${items.length} completion items`,
  };
};

const PROBES = { type: typeProbe, completion: completionProbe };

const run = async () => {
  const work = mkdtempSync(join(tmpdir(), "deno-rootset-graph."));
  console.log(`\nGRAPH RECOVERY - does deno's module graph reach what the root set no longer seeds`);
  console.log(`\nbinary ${BIN}`);
  console.log(`work   ${work}\n`);
  console.log(
    `Each case is built twice. The arms differ only in the root tsconfig's exclude, which is the only lever on a`
  );
  console.log(
    `released binary that removes a file from the root set at this call site. roots-pruned stands in for any`
  );
  console.log(`mechanism that prunes the walk: they all reach the file set through the same predicate.\n`);
  console.log(
    `  ${"case".padEnd(26)}${"probe".padEnd(12)}${"roots-all".padEnd(12)}${"roots-pruned".padEnd(14)}recovered`
  );

  const rows = [];
  for (const kase of CASES) {
    const outcome = {};
    for (const arm of ARMS) {
      const built = buildCase(work, kase, arm);
      const session = openSession({ bin: BIN, root: built.root, settings: SETTINGS });
      await session.start();
      const uri = session.openFile(built.entry);
      await new Promise((settle) => setTimeout(settle, 1500));
      outcome[arm.key] = await PROBES[kase.probe](session, uri);
      outcome[`${arm.key}-diagnostics`] = (session.diagnostics.get(uri) ?? []).map((d) => d.message);
      session.close();
    }
    const recovered = outcome["roots-all"].signal === outcome["roots-pruned"].signal;
    rows.push({ kase, outcome, recovered });
    console.log(
      `  ${kase.name.padEnd(26)}${kase.probe.padEnd(12)}${outcome["roots-all"].signal.padEnd(12)}` +
        `${outcome["roots-pruned"].signal.padEnd(14)}${recovered ? "yes" : "NO"}`
    );
  }

  console.log(`\ndetail\n`);
  for (const row of rows) {
    console.log(`  ${row.kase.name}  -  ${row.kase.question}`);
    for (const arm of ARMS) {
      const at = row.outcome[arm.key];
      const diagnostics = row.outcome[`${arm.key}-diagnostics`];
      console.log(`    ${arm.key.padEnd(14)} ${at.signal.padEnd(10)} ${at.detail}`);
      console.log(
        `    ${"".padEnd(14)} diagnostics: ${diagnostics.length === 0 ? "none" : diagnostics.join(" | ")}`
      );
    }
    console.log("");
  }
  process.exit(0);
};

await run();
