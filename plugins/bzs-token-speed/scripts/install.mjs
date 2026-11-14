// Install: inject the TokenPulse composer chip into ZCode's renderer (app.asar)
// and record how to reach the loopback HTTP host.
//
// Usage: node install.mjs [--port <port>] [--base <url>] [--dry-run] [--force]
// Also exported as `ensureInstalled()` so the MCP server can self-heal after
// ZCode updates or plugin upgrades without manual CLI intervention.
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  readFileFromAsar,
  buildAsarWithReplacedFile,
  installArchive,
} from "./lib/asar.mjs";
import {
  APP_ASAR,
  BACKUP_ASAR,
  STATE_FILE,
  PORT_FILE,
  PREFERRED_PORT,
  RENDERER_INDEX,
  computeChipVersionTag,
  injectSnippet,
  stripInjection,
  hasInjection,
  extractInjectedMeta,
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

function readZCodeVersion(asarPath) {
  try {
    const raw = readFileFromAsar(asarPath, "package.json").toString("utf8");
    return JSON.parse(raw).version ?? null;
  } catch {
    return null;
  }
}

function readSavedState() {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function resolveEndpoint({ base, port } = {}) {
  if (base) return base;
  if (port) return `http://127.0.0.1:${port}`;
  if (existsSync(PORT_FILE)) {
    try {
      const p = JSON.parse(readFileSync(PORT_FILE, "utf8")).port;
      if (Number.isInteger(p) && p > 0) return `http://127.0.0.1:${p}`;
    } catch {}
  }
  return `http://127.0.0.1:${PREFERRED_PORT}`;
}

function htmlWithMeta(html, baseUrl, versionTag) {
  const metas = [
    `<meta name="bzs-token-speed-base" content="${baseUrl}">`,
    `<meta name="bzs-token-speed-version" content="${versionTag}">`,
  ].join("\n    ");
  return html.replace(/<head([^>]*)>/i, (m) => `${m}\n    ${metas}`);
}

export function ensureInstalled({
  base: explicitBase,
  port,
  dryRun = false,
  force = false,
  asarPath = APP_ASAR,
} = {}) {
  if (!existsSync(asarPath)) {
    return { appAsar: asarPath, installed: false, skipped: "asar_not_found" };
  }

  const chip = readFileSync(CHIP_PATH, "utf8");
  const versionTag = computeChipVersionTag(chip);
  const base = resolveEndpoint({ base: explicitBase, port });
  const zcodeVersion = readZCodeVersion(asarPath);
  const indexHtml = readFileFromAsar(asarPath, RENDERER_INDEX).toString("utf8");
  const existingMeta = extractInjectedMeta(indexHtml);

  // Fast path: already injected with the exact current chip hash & endpoint.
  if (
    !force &&
    hasInjection(indexHtml) &&
    existingMeta.versionTag === versionTag &&
    existingMeta.endpoint === base
  ) {
    return {
      appAsar: asarPath,
      zcodeVersion,
      versionTag,
      endpoint: base,
      upToDate: true,
      installed: false,
    };
  }

  const { html: stripped, hadInjection } = stripInjection(indexHtml);
  if (hasInjection(stripped)) {
    throw new Error("injection markers unbalanced; refusing to edit");
  }

  const snippet = injectSnippet(chip);
  let nextHtml = stripped.replace(/<\/body>/i, `${snippet}\n  </body>`);
  nextHtml = htmlWithMeta(nextHtml, base, versionTag);

  const report = {
    appAsar: asarPath,
    zcodeVersion,
    versionTag,
    dryRun,
    previousInjection: hadInjection,
    endpoint: base,
  };

  const { archive } = buildAsarWithReplacedFile(
    asarPath,
    RENDERER_INDEX,
    Buffer.from(nextHtml, "utf8")
  );
  report.newSize = archive.length;

  if (!dryRun) {
    const prevState = readSavedState();
    // Discard stale full-archive backup if ZCode upgraded to a different version.
    if (
      asarPath === APP_ASAR &&
      existsSync(BACKUP_ASAR) &&
      prevState?.zcodeVersion !== zcodeVersion
    ) {
      rmSync(BACKUP_ASAR, { force: true });
    }
    // Only capture backup from a clean (non-injected) archive so we never overwrite
    // a clean backup with an already-injected archive.
    const saveBackup = asarPath === APP_ASAR && !hadInjection;
    installArchive(asarPath, archive, {
      backupPath: asarPath === APP_ASAR ? BACKUP_ASAR : null,
      saveBackup,
    });
    if (asarPath === APP_ASAR) {
      mkdirSync(dirname(STATE_FILE), { recursive: true });
      writeFileSync(
        STATE_FILE,
        JSON.stringify(
          {
            installedAt: new Date().toISOString(),
            zcodeVersion,
            versionTag,
            endpoint: base,
            chipBytes: chip.length,
          },
          null,
          2
        )
      );
    }
  }

  report.installed = !dryRun;
  return report;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    const report = ensureInstalled(args);
    if (!args.dryRun) {
      const { ensureHttpDaemon } = await import("../server/http.mjs");
      report.daemon = await ensureHttpDaemon();
    }
    console.log(JSON.stringify(report, null, 2));
  })().catch((error) => {
    console.error(`bzs-token-speed install failed: ${error.message}`);
    process.exit(1);
  });
}
