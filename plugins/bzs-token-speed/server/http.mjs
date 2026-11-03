// Loopback HTTP host: the data source for the composer chip and the host of
// the optional dashboard page. Started once when the MCP server boots so the
// chip has a stable endpoint for its whole lifetime.
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  currentSpeedSnapshot,
  sessionSpeedSnapshot,
  activeSessions,
  dbPath,
} from "../lib/service.mjs";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const UI_DIR = join(PLUGIN_ROOT, "ui");
const HOST = "127.0.0.1";
// Preferred port: fixed so the endpoint survives ZCode restarts without a
// re-injection. When taken, the OS assigns a random one and the discovery
// file below tells install.mjs (and any manually launched backend) about it.
const PREFERRED_PORT = 47816;

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  // The renderer page (file:// inside app.asar) reads these endpoints from a
  // different origin; without this header Chromium blocks the response.
  "access-control-allow-origin": "*",
  "vary": "origin",
};

let server = null;
let port = 0;

function sendJson(res, payload) {
  res.writeHead(200, JSON_HEADERS);
  res.end(JSON.stringify(payload));
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${HOST}:${port}`);
  switch (url.pathname) {
    case "/":
    case "/index.html": {
      const html = await readFile(join(UI_DIR, "dashboard.html"), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    case "/api/snapshot": {
      // Explicit session wins; otherwise resolve by the caller-provided dir,
      // falling back to this process's own project dir (the MCP host session).
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
      sendJson(res, { ok: true, db: dbPath() });
      return;
    default:
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
  }
}

export async function startHttpHost() {
  if (server) return port;
  server = createServer(requestHandler);
  await new Promise((resolve) => {
    server.once("error", resolve);
    // Try the fixed port first; fall back to an OS-assigned one so two MCP
    // processes (or a leftover listener) never block the plugin entirely.
    server.listen(PREFERRED_PORT, HOST, resolve);
  }).then((failure) => {
    if (!failure) return null;
    server = createServer(requestHandler);
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, HOST, resolve);
    });
  });
  port = server.address().port;
  await writeDiscoveryFile(port);
  return port;
}

function requestHandler(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      ...JSON_HEADERS,
      "access-control-allow-methods": "GET",
      "access-control-max-age": "86400",
    });
    res.end();
    return;
  }
  handleRequest(req, res).catch((error) => {
    res.writeHead(500, JSON_HEADERS);
    res.end(JSON.stringify({ error: error.message }));
  });
}

// Several MCP processes boot together (one per session). Only the first wins
// the fixed port; the rest fall back to a random one. Unconditional writes
// would let a loser clobber the file with a port that dies with it, so a
// fallback instance first checks whether the fixed host is answering and, if
// so, records that stable endpoint instead of its own.
async function preferredHostAnswers() {
  try {
    const res = await fetch(`http://${HOST}:${PREFERRED_PORT}/api/ping`, {
      signal: AbortSignal.timeout(500),
    });
    if (!res.ok) return false;
    return (await res.json())?.ok === true;
  } catch {
    return false;
  }
}

// The injected chip reads its endpoint from a <meta> baked in at install
// time, which goes stale when the port changes. This file is the fresh
// source of truth: install.mjs embeds the latest value on re-injection, and
// the chip falls back to the fixed port when the baked one is dead.
async function writeDiscoveryFile(activePort) {
  const recorded =
    activePort !== PREFERRED_PORT && (await preferredHostAnswers())
      ? PREFERRED_PORT
      : activePort;
  try {
    const dir = join(
      process.env.LOCALAPPDATA ?? join(process.env.HOME ?? "", "AppData", "Local"),
      "Programs", "ZCode", "resources", "bzs-token-speed-backup"
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "http-port.json"),
      JSON.stringify({ port: recorded, preferredPort: PREFERRED_PORT, updatedAt: new Date().toISOString() }, null, 2)
    );
  } catch (error) {
    process.stderr.write(`bzs-token-speed: cannot write discovery file: ${error.message}\n`);
  }
}

export function httpBaseUrl() {
  return server ? `http://${HOST}:${port}` : null;
}

export function stopHttpHost() {
  if (!server) return Promise.resolve();
  const closing = new Promise((resolve) => server.close(resolve));
  server = null;
  port = 0;
  return closing;
}
