// Uninstall: restore the pristine renderer. Prefers the original archive
// captured at first install (app.asar.orig); falls back to stripping the
// injection markers from the current archive when no backup exists.
import { readFileSync, writeFileSync, renameSync, rmSync, existsSync, mkdirSync } from "node:fs";
import {
  readFileFromAsar,
  buildAsarWithReplacedFile,
} from "./lib/asar.mjs";
import {
  APP_ASAR,
  BACKUP_ASAR,
  STATE_FILE,
  RENDERER_INDEX,
  stripInjection,
} from "./lib/target.mjs";

function restoreFromBackup() {
  const tmp = `${APP_ASAR}.tmp-bzs`;
  writeFileSync(tmp, readFileSync(BACKUP_ASAR));
  renameSync(tmp, APP_ASAR);
  rmSync(STATE_FILE, { force: true });
  return { restoredFrom: BACKUP_ASAR };
}

function restoreByStripping() {
  const html = readFileFromAsar(APP_ASAR, RENDERER_INDEX).toString("utf8");
  const { html: stripped, hadInjection } = stripInjection(html);
  if (!hadInjection) return { restoredFrom: null, note: "no injection found; nothing to do" };
  const metaRe = /[ \t]*<meta name="bzs-token-speed-base"[^>]*>\n?/g;
  const cleaned = stripped.replace(metaRe, "");
  const { archive } = buildAsarWithReplacedFile(
    APP_ASAR,
    RENDERER_INDEX,
    Buffer.from(cleaned, "utf8")
  );
  const tmp = `${APP_ASAR}.tmp-bzs`;
  writeFileSync(tmp, archive);
  renameSync(tmp, APP_ASAR);
  rmSync(STATE_FILE, { force: true });
  return { restoredFrom: "strip-in-place" };
}

const backupUsable = existsSync(BACKUP_ASAR);
const result = backupUsable ? restoreFromBackup() : restoreByStripping();
console.log(JSON.stringify({ appAsar: APP_ASAR, ...result }, null, 2));
