// Install: inject the composer chip into ZCode's renderer (app.asar) and
// record how to reach the token-speed HTTP host.
//
// Usage: node install.mjs [--port <port>] [--base <url>] [--dry-run] [--force]
//   --port/--base  override the endpoint; default auto-discovery handles it
//   --dry-run      verify and report without writing
//   --force        re-inject even when a previous injection was detected
//
// The endpoint is baked into the renderer as a <meta> tag. install.mjs reads
// the freshest port from http-port.json (written by the MCP process on boot)
// and embeds it, so changing the port only needs a re-run of this script.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readFileFromAsar,
  buildAsarWithReplacedFile,
  installArchive,
} from "./lib/asar.mjs";
import {
  APP_ASAR,
  BACKUP_ASAR,
  STATE_FILE,
  RENDERER_INDEX,
  injectSnippet,
  stripInjection,
  hasInjection,
} from "./lib/target.mjs";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHIP_PATH = join(PLUGIN_ROOT, "composer", "chip.mjs");

function parseArgs(argv) {
  const out = { dryRun: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") out.dryRun = true;
    else if (argv[i] === "--force") out.force = true;
    else if (argv[i] === "--port") out.port = Number(argv[++i]);
    else if (argv[i] === "--base") out.base = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return out;
}

function chipSource(baseUrl) {
  const raw = readFileSync(CHIP_PATH, "utf8");
  // The chip is authored as a plain module body; strip the export-free IIFE
  // wrapper is unnecessary — it is already self-invoking and side-effect only.
  // Discover the endpoint from the injected meta tag instead of baking it in.
  return raw;
}

function htmlWithEndpoint(html, baseUrl) {
  // The chip reads data-bzs-token-speed-base from <html>; a dedicated meta
  // keeps that attribute free for other uses.
  const meta = `<meta name="bzs-token-speed-base" content="${baseUrl}">`;
  return html.replace(/<head([^>]*)>/i, (m) => `${m}\n    ${meta}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const indexHtml = readFileFromAsar(APP_ASAR, RENDERER_INDEX).toString("utf8");

  const report = { appAsar: APP_ASAR, dryRun: args.dryRun };
  const { html: stripped, hadInjection } = stripInjection(indexHtml);
  report.previousInjection = hadInjection;
  if (hasInjection(stripped)) {
    throw new Error("injection markers present without begin marker; refusing to edit");
  }
  if (hadInjection && !args.force && !args.dryRun) {
    // Re-injection is the normal update path; markers make it idempotent.
  }

  // Resolve the chip endpoint: explicit --base wins, else --port, else a
  // discovery URL the chip resolves at runtime (loopback scan is avoided;
  // default expects the HTTP host on the well-known discovery file).
  let base = args.base ?? null;
  if (!base && args.port) base = `http://127.0.0.1:${args.port}`;

  // Endpoint discovery: the MCP process writes its port here on every boot,
  // and install embeds the freshest known value. The chip also re-checks this
  // file every 30s in case the port changed after a ZCode restart.
  const discoveryPath = join(dirname(STATE_FILE), "http-port.json");
  let portFromFile = null;
  if (!base && existsSync(discoveryPath)) {
    try {
      portFromFile = JSON.parse(readFileSync(discoveryPath, "utf8")).port ?? null;
    } catch {
      portFromFile = null;
    }
  }
  if (!base && portFromFile) base = `http://127.0.0.1:${portFromFile}`;
  if (!base) {
    throw new Error(
      "no endpoint known: start ZCode with the plugin installed once (it writes http-port.json), or pass --port"
    );
  }
  report.endpoint = base;

  const chip = chipSource(base);
  const snippet = injectSnippet(chip);
  let nextHtml = stripped.replace(/<\/body>/i, `${snippet}\n  </body>`);
  nextHtml = htmlWithEndpoint(nextHtml, base);

  const { archive } = buildAsarWithReplacedFile(
    APP_ASAR,
    RENDERER_INDEX,
    Buffer.from(nextHtml, "utf8")
  );
  report.newSize = archive.length;

  if (!args.dryRun) {
    installArchive(APP_ASAR, archive, { backupPath: BACKUP_ASAR });
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(
      STATE_FILE,
      JSON.stringify(
        { installedAt: new Date().toISOString(), endpoint: base, chipBytes: chip.length },
        null,
        2
      )
    );
  }
  report.installed = !args.dryRun;
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(`bzs-token-speed install failed: ${error.message}`);
  process.exit(1);
});
