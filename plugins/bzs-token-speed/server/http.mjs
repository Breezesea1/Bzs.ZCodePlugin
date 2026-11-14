// Loopback HTTP host: the data source for the TokenPulse composer chip.
// Runs as a single shared loopback daemon on 127.0.0.1:47816 so closing the
// first session never strands the renderer chip on a dead port, and self-exits
// automatically once all ZCode windows close (no polling traffic for 3 minutes).
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  currentSpeedSnapshot,
  sessionSpeedSnapshot,
  activeSessions,
  dbPath,
} from "../lib/service.mjs";
import { close as closeDb } from "../lib/db.mjs";
import { PORT_FILE, PREFERRED_PORT, PLUGIN_VERSION } from "../scripts/lib/target.mjs";

const SELF_PATH = fileURLToPath(import.meta.url);
const HOST = "127.0.0.1";
const DAEMON_IDLE_EXIT_MS = 3 * 60 * 1000;

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
  "access-control-allow-private-network": "true",
  "vary": "origin",
};

let server = null;
let port = 0;
let lastTrafficAt = Date.now();
let idleWatchTimer = null;

function sendJson(res, payload, status = 200) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(payload));
}

async function handleRequest(req, res) {
  lastTrafficAt = Date.now();
  const url = new URL(req.url, `http://${HOST}:${port || PREFERRED_PORT}`);

  if (req.method === "POST" && url.pathname === "/api/shutdown") {
    sendJson(res, { ok: true, shuttingDown: true });
    setTimeout(async () => {
      await stopHttpHost();
      closeDb();
      process.exit(0);
    }, 30);
    return;
  }

  switch (url.pathname) {
    case "/api/snapshot": {
      const explicit = url.searchParams.get("session");
      const dir =
        url.searchParams.get("dir") ?? process.env.ZCODE_PROJECT_DIR ?? undefined;
      const snap = explicit
        ? sessionSpeedSnapshot({ sessionId: explicit })
        : currentSpeedSnapshot({ workingDir: dir });
      sendJson(res, snap);
      return;
    }
    case "/api/board":
      sendJson(res, { now: Date.now(), sessions: activeSessions({}) });
      return;
    case "/api/ping":
      sendJson(res, {
        ok: true,
        version: PLUGIN_VERSION,
        port,
        pid: process.pid,
        db: dbPath(),
      });
      return;
    default:
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
  }
}

function requestHandler(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      ...JSON_HEADERS,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-max-age": "86400",
    });
    res.end();
    return;
  }
  handleRequest(req, res).catch((error) => {
    sendJson(res, { error: error.message }, 500);
  });
}

function tryListen(targetPort) {
  return new Promise((resolve) => {
    const srv = createServer(requestHandler);
    const onError = (err) => {
      try {
        srv.close();
      } catch {}
      resolve({ ok: false, error: err });
    };
    srv.once("error", onError);
    srv.listen(targetPort, HOST, () => {
      srv.removeListener("error", onError);
      resolve({ ok: true, server: srv, port: srv.address().port });
    });
  });
}

export async function probePreferredHost() {
  try {
    const res = await fetch(`http://${HOST}:${PREFERRED_PORT}/api/ping`, {
      signal: AbortSignal.timeout(600),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.ok === true ? body : null;
  } catch {
    return null;
  }
}

async function shutdownPreferredHost() {
  try {
    await fetch(`http://${HOST}:${PREFERRED_PORT}/api/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(800),
    });
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 60));
      if (!(await probePreferredHost())) return true;
    }
  } catch {}
  return false;
}

// Ensure a detached daemon is serving 127.0.0.1:47816 on the current plugin version.
// Falls back to an in-process listener if detached spawn cannot bind.
export async function ensureHttpDaemon() {
  const existing = await probePreferredHost();
  if (existing && existing.version === PLUGIN_VERSION) {
    return { port: PREFERRED_PORT, mode: "reused", pid: existing.pid };
  }
  if (existing && existing.version !== PLUGIN_VERSION) {
    await shutdownPreferredHost();
  }

  try {
    const child = spawn(process.execPath, [SELF_PATH, "--daemon"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env },
    });
    child.unref();

    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 80));
      const live = await probePreferredHost();
      if (live?.ok) {
        return { port: PREFERRED_PORT, mode: "daemon", pid: live.pid };
      }
    }
  } catch {}

  const fallbackPort = await startHttpHost();
  return { port: fallbackPort, mode: "in-process", pid: process.pid };
}

export async function startHttpHost({ daemonMode = false } = {}) {
  if (server) return port;
  let bound = await tryListen(PREFERRED_PORT);
  if (!bound.ok) {
    if (daemonMode) {
      // Another daemon just won the race on 47816; exit cleanly.
      process.exit(0);
    }
    bound = await tryListen(0);
    if (!bound.ok) throw bound.error;
  }
  server = bound.server;
  port = bound.port;
  lastTrafficAt = Date.now();
  await writeDiscoveryFile(port);

  if (daemonMode) {
    idleWatchTimer = setInterval(async () => {
      if (Date.now() - lastTrafficAt > DAEMON_IDLE_EXIT_MS) {
        await stopHttpHost();
        closeDb();
        process.exit(0);
      }
    }, 30_000);
    idleWatchTimer.unref?.();
  }
  return port;
}

async function writeDiscoveryFile(activePort) {
  const existing = activePort !== PREFERRED_PORT ? await probePreferredHost() : null;
  const recorded = existing ? PREFERRED_PORT : activePort;
  try {
    mkdirSync(dirname(PORT_FILE), { recursive: true });
    writeFileSync(
      PORT_FILE,
      JSON.stringify(
        {
          port: recorded,
          preferredPort: PREFERRED_PORT,
          version: PLUGIN_VERSION,
          updatedAt: new Date().toISOString(),
        },
        null,
        2
      )
    );
  } catch (error) {
    process.stderr.write(
      `bzs-token-speed: cannot write discovery file: ${error.message}\n`
    );
  }
}

export function httpBaseUrl() {
  return server ? `http://${HOST}:${port}` : null;
}

export function stopHttpHost() {
  if (idleWatchTimer) {
    clearInterval(idleWatchTimer);
    idleWatchTimer = null;
  }
  if (!server) return Promise.resolve();
  const closing = new Promise((resolve) => server.close(resolve));
  server = null;
  port = 0;
  return closing;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain && process.argv.includes("--daemon")) {
  startHttpHost({ daemonMode: true }).catch((error) => {
    process.stderr.write(`bzs-token-speed daemon failed: ${error.message}\n`);
    process.exit(1);
  });
}
