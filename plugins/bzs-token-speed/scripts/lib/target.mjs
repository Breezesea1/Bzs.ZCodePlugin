// Constants and HTML marker helpers shared by install/uninstall/status scripts.
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

export const PLUGIN_VERSION = "0.3.0";
export const PREFERRED_PORT = 47816;

export const ZCODE_RESOURCES = join(
  process.env.ZCODE_RESOURCES_DIR ??
    join(
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
      "Programs",
      "ZCode",
      "resources"
    )
);
export const APP_ASAR = join(ZCODE_RESOURCES, "app.asar");
export const BACKUP_DIR = join(ZCODE_RESOURCES, "bzs-token-speed-backup");
export const BACKUP_ASAR = join(BACKUP_DIR, "app.asar.orig");
export const STATE_FILE = join(BACKUP_DIR, "install-state.json");
export const PORT_FILE = join(BACKUP_DIR, "http-port.json");

// The single file we touch inside the archive.
export const RENDERER_INDEX = "out/renderer/index.html";

// Marker comments bracketing our injection so reinstalls and uninstalls are
// idempotent even across plugin and ZCode version bumps.
export const INJECT_BEGIN = "<!-- bzs-token-speed:begin -->";
export const INJECT_END = "<!-- bzs-token-speed:end -->";

const META_TAGS_RE = /[ \t]*<meta name="bzs-token-speed-(?:base|version)"[^>]*>\r?\n?/gi;

export function computeChipVersionTag(chipScript) {
  const hash8 = createHash("sha256").update(chipScript).digest("hex").slice(0, 8);
  return `${PLUGIN_VERSION}:${hash8}`;
}

export function injectSnippet(chipScript) {
  return [
    INJECT_BEGIN,
    `<script type="module">${chipScript}</script>`,
    INJECT_END,
  ].join("\n");
}

export function stripInjection(html) {
  let cleaned = html;
  let hadInjection = false;

  while (true) {
    const begin = cleaned.indexOf(INJECT_BEGIN);
    if (begin < 0) break;
    const end = cleaned.indexOf(INJECT_END, begin);
    if (end < 0) {
      throw new Error("injection markers unbalanced; refusing to edit");
    }
    let sliceStart = begin;
    let sliceEnd = end + INJECT_END.length;
    if (cleaned[sliceEnd] === "\r") sliceEnd += 1;
    if (cleaned[sliceEnd] === "\n") sliceEnd += 1;
    cleaned = cleaned.slice(0, sliceStart) + cleaned.slice(sliceEnd);
    hadInjection = true;
  }

  if (META_TAGS_RE.test(cleaned)) {
    cleaned = cleaned.replace(META_TAGS_RE, "");
    hadInjection = true;
  }

  return { html: cleaned, hadInjection };
}

export function hasInjection(html) {
  return html.includes(INJECT_BEGIN) || html.includes(INJECT_END);
}

export function extractInjectedMeta(html) {
  const endpoint =
    html.match(/<meta name="bzs-token-speed-base" content="([^"]+)">/i)?.[1] ??
    null;
  const versionTag =
    html.match(/<meta name="bzs-token-speed-version" content="([^"]+)">/i)?.[1] ??
    null;
  return { endpoint, versionTag };
}
