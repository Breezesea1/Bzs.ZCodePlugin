// 网关 RPC 客户端（照抄 suian gateway-client 方案，改用 vendored ws）：
// 1) GET /health 校验网关与 Desktop 就绪；2) WS /rpc 用 control_token 握手，
// attach 后经 RPC 帧多路复用调用 zcode-task / zcode-agent / model-selection。
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "../vendor/ws/index.js";
import { ChannelClient } from "../vendor/channelClient.js";
import { Emitter } from "../vendor/foundation.js";
import { VSBuffer } from "../vendor/buffer.js";
import { rpcDiagnostic } from "./rpc-diagnostics.mjs";

const failure = (reasonCode, message, stage = "gateway") => Object.assign(new Error(message), { stage, reasonCode });
export const defaultConfig = join(homedir(), ".zcode", "bzs-zcode-session-title", "gateway", "config.json");

export async function connectHost({ workspacePath, sessionId, gatewayConfigPath = defaultConfig, timeoutMs = 120000, handshakeTimeoutMs = 8000 }) {
  const started = Date.now();
  let clientPhase = "health";
  let config;
  try { config = JSON.parse(await readFile(gatewayConfigPath, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") throw failure("gateway_not_configured", "网关尚未配置，请先运行 scripts/install-gateway.mjs", "config");
    if (error instanceof SyntaxError) throw failure("gateway_invalid_config", "网关配置 JSON 无效", "config");
    throw error;
  }
  if (config.version !== 1 || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || typeof config.control_token !== "string" || !config.control_token) throw failure("gateway_invalid_config", "网关配置无效", "config");
  const healthUrl = `http://127.0.0.1:${config.port}/health`;
  let health;
  try { health = await (await fetch(healthUrl, { signal: AbortSignal.timeout(handshakeTimeoutMs) })).json(); }
  catch (error) { throw Object.assign(failure("gateway_unreachable", "网关健康检查失败：" + error.name), {
    cause: error, diagnostic: rpcDiagnostic(error, { phase: "health", clientPhase, elapsedMs: Date.now() - started })
  }); }
  const diagnose = (error, context = {}) => {
    // ChannelClient 的 PromiseErrorObj 可以直接拒绝字符串或 null；保留其原值。
    if (error === null || typeof error !== "object") return error;
    error.diagnostic = rpcDiagnostic(error, { clientPhase, elapsedMs: Date.now() - started,
      gatewayVersion: health.build?.version ?? error.diagnostic?.gatewayVersion,
      mode: "relay", relayProtocolVersion: health.relay_protocol_version ?? error.diagnostic?.relayProtocolVersion, ...context });
    return error;
  };
  if (health.service !== "bzs-zcode-session-title-gateway" || health.rpc_protocol_version !== 1) throw diagnose(failure("gateway_upgrade_required", "运行中的网关不是本插件的 RPC 网关，请重装后重试"), { phase: "health" });
  if (!health.desktop_connected || !health.upstream_connected) throw diagnose(failure("gateway_desktop_offline", "Desktop 尚未就绪，或官方上游尚未连接"), { phase: "health" });
  const ready = Promise.withResolvers(), fault = Promise.withResolvers(), emitter = new Emitter();
  const socket = new WebSocket(`ws://127.0.0.1:${config.port}/rpc`, { headers: { Authorization: `Bearer ${config.control_token}` }, handshakeTimeout: handshakeTimeoutMs });
  const client = new ChannelClient({ onMessage: emitter.event, send: bytes => socket.send(bytes.buffer), drain: () => Promise.resolve() });
  let attached, closing = false;
  let timer = setTimeout(() => fault.reject(Object.assign(failure("gateway_timeout", "网关附着超时"), {
    diagnostic: { phase: "attach_timeout" }
  })), handshakeTimeoutMs);
  clientPhase = "connect";
  socket.on("open", () => socket.send(JSON.stringify({ type: "attach", workspace_path: workspacePath, ...(sessionId === undefined ? {} : { session_id: sessionId }) })));
  socket.on("message", (data, binary) => {
    try {
      if (binary) { emitter.fire(VSBuffer.wrap(data)); return; }
      const message = JSON.parse(data.toString());
      if (message.type === "attached") { attached = message; ready.resolve(); }
      else if (message.type === "error") fault.reject(failure(message.code ?? "gateway_rpc_failed", message.message));
    } catch (error) {
      fault.reject(Object.assign(failure("gateway_rpc_protocol_error", "网关 RPC 消息无效，已提交操作结果可能未知"), { cause: error }));
      close();
    }
  });
  socket.on("error", () => fault.reject(failure("gateway_connection_failed", "网关 RPC 连接失败")));
  socket.on("close", () => { if (!closing) fault.reject(failure("gateway_connection_closed", "网关 RPC 连接已断开，已提交的操作结果可能未知")); });
  const close = () => { closing = true; clearTimeout(timer); socket.close(); client.dispose(); emitter.dispose(); };
  try {
    await Promise.race([Promise.all([ready.promise, client.whenInitialized()]), fault.promise]);
    clearTimeout(timer); timer = setTimeout(() => fault.reject(failure("gateway_timeout", "原 Host RPC 执行超时，结果可能未知")), timeoutMs);
    return {
      bootstrap: attached.bootstrap, workspacePath: attached.workspace_path,
      call: (channel, method, args = []) => Promise.race([client.getChannel(channel).call(method, args), fault.promise]).catch(error => { throw diagnose(error); }),
      probe: async () => {
        try {
          const current = await (await fetch(healthUrl, { signal: AbortSignal.timeout(handshakeTimeoutMs) })).json();
          return { ok: current.desktop_connected && current.upstream_connected, stage: "gateway", mode: current.mode, paired: current.paired, upstreamPaired: current.upstream_paired, localClients: current.local_clients };
        } catch (cause) {
          throw diagnose(Object.assign(failure("gateway_unreachable", "网关健康检查失败：" + cause.name), { cause }), { phase: "health", clientPhase: "health" });
        }
      },
      close
    };
  } catch (error) { close(); throw diagnose(error); }
}

export async function probeHost(options) {
  let connection;
  try {
    connection = await connectHost({ ...options, handshakeTimeoutMs: options.timeoutMs ?? 8000 });
    return { ...await connection.probe(), hostReachable: true, workspaceFound: true, sessionFound: true };
  } catch (error) {
    return { ok: false, stage: error.stage ?? "gateway", reasonCode: error.reasonCode ?? "gateway_error", paired: false, message: error.message, ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}) };
  } finally { connection?.close(); }
}
