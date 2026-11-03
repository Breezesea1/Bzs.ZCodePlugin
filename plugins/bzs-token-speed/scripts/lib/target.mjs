// Constants shared by the install/uninstall/status scripts.
import { join } from "node:path";
import { homedir } from "node:os";

export const ZCODE_RESOURCES = join(
  process.env.ZCODE_RESOURCES_DIR ?? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Programs", "ZCode", "resources")
);
export const APP_ASAR = join(ZCODE_RESOURCES, "app.asar");
export const BACKUP_DIR = join(ZCODE_RESOURCES, "bzs-token-speed-backup");
export const BACKUP_ASAR = join(BACKUP_DIR, "app.asar.orig");
export const STATE_FILE = join(BACKUP_DIR, "install-state.json");

// The single file we touch inside the archive.
export const RENDERER_INDEX = "out/renderer/index.html";

// Marker comments bracketing our injection so reinstalls and uninstalls are
// idempotent even across plugin version bumps.
export const INJECT_BEGIN = "<!-- bzs-token-speed:begin -->";
export const INJECT_END = "<!-- bzs-token-speed:end -->";

export function injectSnippet(chipScript) {
  return [
    INJECT_BEGIN,
    `<script type="module">${chipScript}</script>`,
    INJECT_END,
  ].join("\n");
}

export function stripInjection(html) {
  const begin = html.indexOf(INJECT_BEGIN);
  if (begin < 0) return { html, hadInjection: false };
  const end = html.indexOf(INJECT_END, begin);
  if (end < 0) throw new Error("injection markers unbalanced; refusing to edit");
  return {
    html: html.slice(0, begin) + html.slice(end + INJECT_END.length),
    hadInjection: true,
  };
}

export function hasInjection(html) {
  return html.includes(INJECT_BEGIN);
}
