// Status: report whether the chip is injected, which endpoint it uses, and
// whether the HTTP host is reachable. Safe to run any time.
import { existsSync, readFileSync } from "node:fs";
import { readFileFromAsar } from "./lib/asar.mjs";
import { APP_ASAR, BACKUP_ASAR, STATE_FILE, RENDERER_INDEX, hasInjection } from "./lib/target.mjs";

let injected = false;
let endpoint = null;
try {
  const html = readFileFromAsar(APP_ASAR, RENDERER_INDEX).toString("utf8");
  injected = hasInjection(html);
  endpoint = html.match(/<meta name="bzs-token-speed-base" content="([^"]+)">/)?.[1] ?? null;
} catch (error) {
  console.error(`cannot read ${APP_ASAR}: ${error.message}`);
}

let hostUp = false;
if (endpoint) {
  try {
    const res = await fetch(`${endpoint}/api/ping`, { signal: AbortSignal.timeout(1500) });
    hostUp = res.ok;
  } catch {
    hostUp = false;
  }
}

console.log(
  JSON.stringify(
    {
      appAsar: APP_ASAR,
      chipInjected: injected,
      endpoint,
      httpHostReachable: hostUp,
      backupExists: existsSync(BACKUP_ASAR),
      state: existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : null,
    },
    null,
    2
  )
);
