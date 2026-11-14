// Status: report whether the chip is injected, whether its version matches the
// current plugin build, and whether the loopback HTTP host is reachable.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileFromAsar } from "./lib/asar.mjs";
import {
  APP_ASAR,
  BACKUP_ASAR,
  STATE_FILE,
  PREFERRED_PORT,
  RENDERER_INDEX,
  computeChipVersionTag,
  hasInjection,
  extractInjectedMeta,
} from "./lib/target.mjs";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHIP_PATH = join(PLUGIN_ROOT, "composer", "chip.mjs");

export async function inspectStatus({ asarPath = APP_ASAR } = {}) {
  const expectedVersionTag = computeChipVersionTag(readFileSync(CHIP_PATH, "utf8"));
  let injected = false;
  let endpoint = null;
  let versionTag = null;
  let zcodeVersion = null;

  try {
    const html = readFileFromAsar(asarPath, RENDERER_INDEX).toString("utf8");
    injected = hasInjection(html);
    const meta = extractInjectedMeta(html);
    endpoint = meta.endpoint;
    versionTag = meta.versionTag;
    zcodeVersion =
      JSON.parse(readFileFromAsar(asarPath, "package.json").toString("utf8")).version ??
      null;
  } catch (error) {
    return {
      appAsar: asarPath,
      error: error.message,
      chipInjected: false,
      chipUpToDate: false,
    };
  }

  const probeUrl = endpoint ?? `http://127.0.0.1:${PREFERRED_PORT}`;
  let hostUp = false;
  try {
    const res = await fetch(`${probeUrl}/api/ping`, {
      signal: AbortSignal.timeout(1200),
    });
    hostUp = res.ok;
  } catch {
    hostUp = false;
  }

  return {
    appAsar: asarPath,
    zcodeVersion,
    chipInjected: injected,
    chipUpToDate: injected && versionTag === expectedVersionTag,
    injectedVersionTag: versionTag,
    expectedVersionTag,
    endpoint,
    httpHostReachable: hostUp,
    backupExists: existsSync(BACKUP_ASAR),
    state: existsSync(STATE_FILE)
      ? JSON.parse(readFileSync(STATE_FILE, "utf8"))
      : null,
  };
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  console.log(JSON.stringify(await inspectStatus(), null, 2));
}
