// 本地回环网关（照抄 suian-zcode-gateway 方案，裁剪为 relay V1 单模式）：
// Desktop ↔ /ws ↔ 本网关 ↔ 官方 relay（wss://zcode.z.ai/ws），插件 worker 走 /rpc。
// 裁剪说明：去除 terminal 模式与 V2 协议分支、gateway-build 指纹（改用静态版本号）；
// 手机中继路径保留——rpc-broker 的配对状态机依赖 upstream 心跳语义。
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import WebSocket from "../vendor/ws/index.js";
const WebSocketServer = WebSocket.WebSocketServer;
import { createRpcBroker } from "./rpc-broker.mjs";
import { rpcDiagnostic, rpcPayloadDiagnostic } from "./rpc-diagnostics.mjs";

export const OFFICIAL_RELAY = "wss://zcode.z.ai/ws";
const GATEWAY_VERSION = "0.3.2-bzs";
// V1 线协议时间戳为毫秒
const unixNow = () => Date.now();

// JSON 只用于观察路由字段；其他文本和二进制消息仍作为不透明数据转发。
function envelope(data, isBinary) {
  if (isBinary) return;
  try { return JSON.parse(data.toString()); }
  catch (error) { if (error instanceof SyntaxError) return; throw error; }
}

// 只接受一个 Desktop，消息体及文本/二进制类型原样转发。
export async function startGateway({ port = 0, instanceId = "bzs-session-title", controlToken, bridgeTimeoutMs = 5000, onError = error => console.error(JSON.stringify({ event: "gateway_error", ...error.diagnostic })), onTraffic = () => {} } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid gateway port");
  let active;
  const reportError = (error, context = {}) => {
    error.diagnostic = rpcDiagnostic(error, { relayProtocolVersion: 1, gatewayVersion: GATEWAY_VERSION,
      desktopVersion: active?.desktopVersion, localClients: active?.localClients.size ?? 0, rpcInFlight: rpcInFlight(), ...context });
    onError(error);
  };
  const rpcInFlight = () => (active?.broker.inFlight?.() ?? 0) + (active?.pending.size ?? 0);
  const http = createServer(async (request, response) => {
    if (request.headers.origin !== undefined) { response.writeHead(403).end(); return; }
    if (request.method === "POST" && request.url.split("?")[0] === "/shutdown" && controlToken) {
      if (request.headers.authorization !== `Bearer ${controlToken}`) { response.writeHead(401).end(); return; }
      const idleOnly = new URL(request.url, "http://127.0.0.1").searchParams.has("idle");
      if (active && !idleOnly) { response.writeHead(409).end("Stop mobile remote control in ZCode first"); return; }
      if (active && idleOnly && rpcInFlight() > 0) {
        response.writeHead(409, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ ok: false, reason: "busy", rpc_in_flight: rpcInFlight() }));
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json", Connection: "close" }).end('{"ok":true}');
      await closeGateway();
      return;
    }
    if (request.method !== "GET" || request.url !== "/health") { response.writeHead(404).end(); return; }
    // charset=utf-8 让 Windows PowerShell 5.1 的 Invoke-RestMethod 正确解码中文部署路径。
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(JSON.stringify({
      service: "bzs-zcode-session-title-gateway", version: 1, build: { version: GATEWAY_VERSION }, instance_id: instanceId, upstream_url: OFFICIAL_RELAY, mode: "relay", relay_protocol_version: 1,
      desktop_connected: active?.desktop.readyState === WebSocket.OPEN,
      desktop_ready: active?.authenticated ?? false,
      upstream_connected: active?.upstream?.readyState === WebSocket.OPEN,
      paired: active?.paired ?? false,
      upstream_paired: active?.phonePaired ?? false,
      local_clients: active?.localClients.size ?? 0,
      rpc_in_flight: rpcInFlight(),
      rpc_protocol_version: 1,
    }));
  });
  const server = new WebSocketServer({ noServer: true });
  const rpcServer = new WebSocketServer({ noServer: true });
  http.on("upgrade", (request, socket, head) => {
    const path = request.url.split("?")[0];
    const rpc = path === "/rpc";
    if (request.headers.origin !== undefined || (rpc && (!controlToken || request.headers.authorization !== `Bearer ${controlToken}`))) { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return; }
    if (path !== "/ws" && !rpc) { socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); return; }
    const target = rpc ? rpcServer : server;
    target.handleUpgrade(request, socket, head, ws => target.emit("connection", ws, request));
  });
  rpcServer.on("connection", socket => {
    if (!active?.authenticated) { socket.close(1013, "Desktop is not authenticated"); return; }
    const connection = active;
    connection.localClients.add(socket);
    connection.paired = true;
    if (!connection.phonePaired) connection.sendPairStatus("matched");
    socket.on("error", error => reportError(error, { phase: "socket", source: "local_rpc" }));
    connection.broker.acceptLocal(socket);
    socket.on("close", () => {
      connection.localClients.delete(socket);
      if (active !== connection) return;
      connection.paired = connection.authenticated && (connection.phonePaired || connection.localClients.size > 0);
      if (!connection.paired && connection.authenticated) connection.sendPairStatus(connection.lastPairAck.pair_status);
    });
  });
  let closing = null;
  // 升级关闭成功后调用方仍可能再次 close（fixture/测试清理）；重复关闭无操作而非报错。
  const closeGateway = () => closing ??= (async () => {
    active?.desktop.terminate();
    active?.upstream?.terminate();
    for (const socket of rpcServer.clients) socket.terminate();
    await Promise.all([
      new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
      new Promise((resolve, reject) => rpcServer.close((error) => error ? reject(error) : resolve())),
      new Promise((resolve, reject) => http.close((error) => error ? reject(error) : resolve())),
    ]);
  })();
  server.on("connection", (desktop, request) => {
    if (active) {
      desktop.close(1008, "Only one Desktop is allowed");
      return;
    }
    const address = new URL(OFFICIAL_RELAY);
    const query = new URL(request.url, "http://127.0.0.1").searchParams;
    const mid = query.get("mid");
    if (mid !== null) address.searchParams.set("mid", mid);
    const deviceId = request.headers["x-device-id"];
    const upstream = new WebSocket(address, { headers: deviceId ? { "X-Device-ID": deviceId } : {} });
    const connection = { desktop, upstream, paired: false, phonePaired: false, authenticated: false, localClients: new Set(), pending: new Map(), localIds: new Set() };
    connection.sendPairStatus = pair_status => desktop.send(JSON.stringify({ ...connection.lastPairAck, pair_status }));
    const sendData = (socket, payload) => socket.send(JSON.stringify({ type: "data", payload, client_ts: Date.now() }));
    connection.sendDesktop = payload => sendData(desktop, payload);
    connection.broker = createRpcBroker({ bootstrap: () => requestBootstrap(connection), bridgeTimeoutMs, onError: reportError,
      sendDesktop: connection.sendDesktop, sendPhone: payload => { if (upstream?.readyState === WebSocket.OPEN) sendData(upstream, payload); } });
    active = connection;
    const queued = [];
    const rejectPending = (error) => {
      for (const pending of connection.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      connection.pending.clear();
    };
    let disconnected = false;
    const disconnect = diagnostic => {
      if (disconnected) return;
      disconnected = true;
      connection.paired = false;
      rejectPending(Object.assign(new Error("连接断开"), { diagnostic }));
      connection.broker.close(Object.assign(new Error("Desktop disconnected"), { diagnostic }));
      for (const socket of rpcServer.clients) socket.close(1011, "Desktop disconnected");
      desktop.terminate();
      upstream?.terminate();
      if (active === connection) active = undefined;
    };
    const connectionClosed = (source, code) => {
      let diagnostic;
      if (!disconnected && !closing && (code !== 1000 || rpcInFlight() > 0)) {
        const error = new Error("Gateway connection closed");
        reportError(error, { phase: "socket", source, closeCode: code, reasonCode: "gateway_connection_closed" });
        diagnostic = error.diagnostic;
      }
      disconnect(diagnostic);
    };
    desktop.on("message", (data, isBinary) => {
      const message = envelope(data, isBinary);
      const payload = message?.payload;
      const local = message?.type === "data" && payload?.zcode_type === "bootstrap-response" && connection.localIds.has(payload.requestId);
      onTraffic({ from: "desktop", type: message?.type ?? null, zcodeType: payload?.zcode_type ?? null, pairStatus: message?.pair_status ?? null, local });
      if (local) {
        const pending = connection.pending.get(payload.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          connection.pending.delete(payload.requestId);
          connection.desktopVersion = payload.result?.desktopAppVersion;
          pending.resolve(payload);
        }
        // 超时、配对结束后的迟到回复也属于本地请求，不发往手机。
        return;
      }
      if (message?.type === "data" && payload) {
        try { if (connection.broker.desktopPayload(payload)) return; }
        catch (error) {
          const failed = Object.assign(new Error("原 Host RPC 协议错误，已提交操作结果可能未知", { cause: error }), { code: "gateway_rpc_protocol_error" });
          reportError(failed, { phase: "desktop_payload", source: "desktop", ...rpcPayloadDiagnostic(payload) });
          connection.broker.close(failed); return;
        }
      }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      else queued.push([data, isBinary]);
    });
    desktop.on("error", (error) => { reportError(error, { phase: "socket", source: "desktop" }); disconnect(error.diagnostic); });
    desktop.on("close", code => connectionClosed("desktop", code));
    upstream.on("open", () => {
      for (const [data, isBinary] of queued) upstream.send(data, { binary: isBinary });
      queued.length = 0;
    });
    upstream.on("message", (data, isBinary) => {
      const message = envelope(data, isBinary);
      onTraffic({ from: "upstream", type: message?.type ?? null, zcodeType: message?.payload?.zcode_type ?? null, pairStatus: message?.pair_status ?? null, local: false });
      if (message?.type === "auth_ack" || message?.type === "pair_status_ack") {
        if (message.type === "auth_ack") connection.authenticated = true;
        // relay 的 terminal_sid 只用于识别终端更换，不是 bootstrap 的 terminalClientSessionId。
        if (message.pair_status !== "matched" || (message.terminal_sid !== undefined && connection.phoneTerminalSid !== undefined && message.terminal_sid !== connection.phoneTerminalSid)) {
          if (!connection.localClients.size) { /* V1 无 terminalClientSessionId */ }
        }
        connection.phoneTerminalSid = message.pair_status === "matched" ? message.terminal_sid ?? connection.phoneTerminalSid : undefined;
        connection.lastPairAck = message;
        connection.phonePaired = message.pair_status === "matched";
        if (!connection.phonePaired) connection.broker.phoneDisconnected();
        connection.paired = connection.authenticated && (connection.phonePaired || connection.localClients.size > 0);
        if (!connection.paired) rejectPending(new Error("配对结束"));
        if (connection.authenticated && !connection.phonePaired && connection.localClients.size > 0) { connection.sendPairStatus("matched"); return; }
      }
      // 已鉴权状态下 WRONG_PARAM 非致命，INTERNAL 等待重新配对但不重做鉴权。
      if (message?.type === "error" && !(connection.authenticated && message.code === "WRONG_PARAM")) {
        connection.authenticated = connection.authenticated && message.code === "INTERNAL";
        connection.phonePaired = false;
        connection.phoneTerminalSid = undefined;
        connection.broker.phoneDisconnected();
        connection.paired = connection.authenticated && connection.localClients.size > 0;
        if (connection.authenticated) connection.lastPairAck = { ...connection.lastPairAck, pair_status: "waiting" };
        // 已鉴权的 INTERNAL 仅影响手机配对；本地 Host 调用可能仍在执行，不截断其 ACK。
        if (connection.paired) { connection.sendPairStatus("matched"); return; }
        rejectPending(new Error(`relay error: ${message.code}`));
        const failed = new Error(`relay error: ${message.code}`);
        reportError(failed, { phase: "socket", source: "upstream" });
        connection.broker.close(failed);
      }
      if (message?.type === "data" && message.payload?.zcode_type === "workspace-bridge-open") { void connection.broker.phoneOpen(message.payload); return; }
      if (message?.type === "data" && ["rpc-frame", "rpc-frame-ack"].includes(message.payload?.zcode_type)) { connection.broker.phoneFrame(message.payload); return; }
      desktop.send(data, { binary: isBinary });
    });
    upstream.on("error", (error) => { reportError(error, { phase: "socket", source: "upstream" }); disconnect(error.diagnostic); });
    upstream.on("close", code => connectionClosed("upstream", code));
  });
  http.listen(port, "127.0.0.1");
  await once(http, "listening");
  function requestBootstrap(connection, timeoutMs = 5000) {
    if (!connection.paired) throw new Error("Desktop 尚未配对");
    const requestId = randomUUID();
    connection.localIds.add(requestId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { connection.pending.delete(requestId); reject(new Error("bootstrap 超时")); }, timeoutMs);
      connection.pending.set(requestId, { resolve, reject, timer });
      connection.sendDesktop({ zcode_type: "bootstrap-request", requestId });
    });
  }
  return {
    url: `ws://127.0.0.1:${http.address().port}/ws`,
    async bootstrap({ timeoutMs = 5000 } = {}) {
      if (!active?.paired) throw new Error("Desktop 尚未配对");
      return requestBootstrap(active, timeoutMs);
    },
    close: closeGateway,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { config: { type: "string" }, port: { type: "string", default: "17329" } } });
  let options = { port: Number(values.port) };
  if (values.config) {
    const config = JSON.parse(await readFile(values.config, "utf8"));
    if (config.version !== 1 || typeof config.control_token !== "string" || !config.control_token) throw new Error("Invalid gateway config");
    options = { port: config.port, controlToken: config.control_token, instanceId: config.instance_id ?? "bzs-session-title" };
  } else {
    // 无配置即裸启动（测试用）；生产入口总是走 --config
    options.controlToken = "dev-standalone";
  }
  const gateway = await startGateway(options);
  // 自包含横幅：stdout 首行进入每次启动的 gateway-<时间戳>.out.log，脱离其他文件仍可溯源
  console.log(JSON.stringify({
    ok: true,
    started_at: new Date().toISOString(),
    port: Number(new URL(gateway.url).port),
    build: { version: GATEWAY_VERSION },
    node: process.version,
    pid: process.pid,
    config: values.config ?? null,
    health_url: gateway.url.replace("ws:", "http:").replace("/ws", "/health"),
  }));
  process.once("SIGINT", () => gateway.close());
  process.once("SIGTERM", () => gateway.close());
}
