// Uninstall: restore the pristine renderer safely across ZCode updates.
// Always strips injection markers from the current app.asar in-place by default
// so an older app.asar.orig can NEVER downgrade a newly updated ZCode client.
import { readFileSync, writeFileSync, rmSync, existsSync, copyFileSync, renameSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  readFileFromAsar,
  buildAsarWithReplacedFile,
  restoreArchive,
} from "./lib/asar.mjs";
import {
  APP_ASAR,
  BACKUP_ASAR,
  STATE_FILE,
  RENDERER_INDEX,
  stripInjection,
} from "./lib/target.mjs";

function readZCodeVersion(asarPath) {
  try {
    return JSON.parse(readFileFromAsar(asarPath, "package.json").toString("utf8")).version ?? null;
  } catch {
    return null;
  }
}

function writeArchiveSafe(targetPath, bytes) {
  const tmp = `${targetPath}.tmp-bzs-${process.pid}`;
  writeFileSync(tmp, bytes);
  try {
    renameSync(tmp, targetPath);
  } catch (err) {
    if (err.code === "EPERM" || err.code === "EBUSY" || err.code === "EACCES") {
      copyFileSync(tmp, targetPath);
      rmSync(tmp, { force: true });
      return;
    }
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function uninstallInjection({ asarPath = APP_ASAR, preferBackup = false } = {}) {
  const currentVersion = readZCodeVersion(asarPath);
  const savedState = existsSync(STATE_FILE)
    ? JSON.parse(readFileSync(STATE_FILE, "utf8"))
    : null;

  if (
    preferBackup &&
    asarPath === APP_ASAR &&
    existsSync(BACKUP_ASAR) &&
    savedState?.zcodeVersion &&
    savedState.zcodeVersion === currentVersion
  ) {
    restoreArchive(asarPath, BACKUP_ASAR);
    rmSync(STATE_FILE, { force: true });
    return { appAsar: asarPath, zcodeVersion: currentVersion, restoredFrom: BACKUP_ASAR };
  }

  const html = readFileFromAsar(asarPath, RENDERER_INDEX).toString("utf8");
  const { html: cleaned, hadInjection } = stripInjection(html);
  if (!hadInjection) {
    if (asarPath === APP_ASAR) rmSync(STATE_FILE, { force: true });
    return {
      appAsar: asarPath,
      zcodeVersion: currentVersion,
      restoredFrom: null,
      note: "no injection found; nothing to do",
    };
  }

  const { archive } = buildAsarWithReplacedFile(
    asarPath,
    RENDERER_INDEX,
    Buffer.from(cleaned, "utf8")
  );
  writeArchiveSafe(asarPath, archive);
  if (asarPath === APP_ASAR) {
    rmSync(STATE_FILE, { force: true });
    if (existsSync(BACKUP_ASAR) && savedState?.zcodeVersion !== currentVersion) {
      rmSync(BACKUP_ASAR, { force: true });
    }
  }
  return { appAsar: asarPath, zcodeVersion: currentVersion, restoredFrom: "strip-in-place" };
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const preferBackup = process.argv.includes("--from-backup");
  const result = uninstallInjection({ preferBackup });
  console.log(JSON.stringify(result, null, 2));
}
