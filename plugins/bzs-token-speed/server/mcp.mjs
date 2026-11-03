// MCP stdio transport: JSON-RPC 2.0 framing implemented by hand to avoid
// shipping a dependency tree into the plugin cache. Tools are thin wrappers
// over the service layer; all formatting lives beside the tool definitions.
import { pathToFileURL } from "node:url";
import { startHttpHost, httpBaseUrl } from "./http.mjs";
import {
  currentSpeedSnapshot,
  sessionSpeedSnapshot,
  activeSessions,
} from "../lib/service.mjs";

const SERVER_NAME = "bzs-token-speed";
const SERVER_VERSION = "0.2.0";
const PROTOCOL_VERSION = "2024-11-05";

const fmtSpd = (v) => (v == null ? "—" : v.toFixed(1));
const fmtTok = (v) =>
  v == null
    ? "—"
    : v >= 1e6
      ? `${(v / 1e6).toFixed(2)}M`
      : v >= 1e3
        ? `${(v / 1e3).toFixed(1)}K`
        : String(v);

function text(result, isError = false) {
  return { content: [{ type: "text", text: result }], ...(isError ? { isError } : {}) };
}

function resolveArgs(args = {}) {
  return {
    sessionId: args.session_id ?? undefined,
    workingDir: args.working_dir ?? process.env.ZCODE_PROJECT_DIR ?? process.cwd(),
  };
}

function speedText(args) {
  const snap = currentSpeedSnapshot(resolveArgs(args));
  if (!snap.session.id) {
    return text("未找到活跃会话：数据库中没有 30 分钟内有活动的交互式会话。", true);
  }
  const m = snap.metrics;
  if (!m?.hasData) {
    return text(`会话 ${snap.session.id}（${snap.session.title ?? "无标题"}）\n该会话暂无已完成的模型请求。`);
  }
  const s = m.speed;
  const idle = m.secondsSinceLastRequest;
  const state = m.streaming ? "流式进行中" : idle == null ? "暂无请求" : `空闲 ${fmtSpd(idle)}s`;
  const latest = s.latest
    ? `${fmtSpd(s.latest.tokPerSec)} tok/s（${s.latest.outputTokens} tok / ${(s.latest.genMs / 1000).toFixed(1)}s，${s.latest.model ?? "—"}）`
    : "—";
  return text(
    [
      `会话 ${snap.session.id} · ${snap.session.title ?? "(无标题)"}`,
      `识别方式：${snap.session.resolvedBy}；状态：${state}`,
      ``,
      `⚡ 解码速度`,
      `  最新请求：${latest}`,
      `  近 10 分钟加权：${fmtSpd(s.recent10m)} tok/s（${s.recentCount} 次请求）`,
      `  会话全程加权：${fmtSpd(s.overall)} tok/s`,
      `  峰值：${fmtSpd(s.peak?.tokPerSec)} tok/s`,
      `  平均 TTFT（首 token 延迟）：${m.ttft.avgMs == null ? "—" : `${(m.ttft.avgMs / 1000).toFixed(1)}s`}`,
      ``,
      `📦 Token 用量`,
      `  输出 ${fmtTok(m.totals.outputTokens)} ｜ 输入 ${fmtTok(m.totals.inputTokens)} ｜ 缓存读 ${fmtTok(m.totals.cacheReadTokens)} ｜ 缓存写 ${fmtTok(m.totals.cacheCreationTokens)} ｜ 推理 ${fmtTok(m.totals.reasoningTokens)}`,
      `  请求 ${m.requestCount} 次 ｜ 模型分布：${Object.entries(m.models).map(([mod, n]) => `${mod}×${n}`).join("，")}`,
    ].join("\n")
  );
}

function speedDetail(args) {
  const snap = currentSpeedSnapshot(resolveArgs(args));
  return text(JSON.stringify(snap, null, 2));
}

async function dashboardTool(args) {
  const snap = currentSpeedSnapshot(resolveArgs(args));
  if (!snap.session.id) {
    return text("未找到活跃会话：数据库中没有 30 分钟内有活动的交互式会话。", true);
  }
  await startHttpHost();
  const url = `${httpBaseUrl()}/`;
  return text(
    [
      "Matrix 仪表盘已就绪。",
      "",
      `▸ 打开链接：${url}`,
      "",
      "页面特性：绿色数字雨背景、CRT 扫描线、实时 tok/s 折线与速度仪表、TTFT / 缓存命中 / Token 用量面板，1 秒自动采样。",
      `监控会话：${snap.session.id}`,
    ].join("\n")
  );
}

function boardText() {
  const sessions = activeSessions({});
  return text(
    [
      `近 1 小时活跃会话：${sessions.length} 个`,
      "",
      ...sessions.map((s) => {
        const idle =
          s.secondsIdle < 90
            ? `${s.secondsIdle.toFixed(0)}s 前`
            : `${(s.secondsIdle / 60).toFixed(0)}min 前`;
        const kind = s.kind === "subagent_child" ? "subagent" : (s.kind ?? "main");
        return `▸ ${idle.padEnd(9)} ${String(s.requests).padStart(4)} 次请求  ${String(s.outputTokens).padStart(7)} tok  [${kind}] ${(s.title ?? "").slice(0, 40)}  ${s.sessionId}`;
      }),
    ].join("\n")
  );
}

const TOOLS = [
  {
    name: "token_speed",
    description:
      "查看当前会话的 token 速度（tok/s）。返回实时解码速率（最新请求）、近 10 分钟加权速率、全程加权速率、峰值、TTFT、缓存命中与 token 总量统计。可选指定 session_id 查看其它会话。",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "可选：目标会话 ID，缺省自动识别当前会话" },
        working_dir: { type: "string", description: "可选：工作目录，用于会话归属推断，缺省取当前进程目录" },
      },
    },
    run: speedText,
  },
  {
    name: "token_speed_detail",
    description:
      "返回当前会话 token 速度的原始结构化数据（JSON）：逐请求速度样本、TTFT 列表、缓存命中、按 query_source 分布等，用于深入分析或绘图。",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "可选：目标会话 ID" },
        working_dir: { type: "string", description: "可选：工作目录" },
      },
    },
    run: speedDetail,
  },
  {
    name: "token_speed_dashboard",
    description:
      "启动黑客帝国（Matrix）风格实时 token 速度监控仪表盘（本地网页：数字雨、CRT 扫描线、实时速度图表），返回可直接打开的 URL。服务常驻直到进程退出。",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "可选：目标会话 ID，缺省自动识别" },
      },
    },
    run: dashboardTool,
  },
  {
    name: "token_speed_board",
    description:
      "列出近 1 小时内有模型流量的全部会话（含子 agent 会话），展示各自最近活动时间、请求次数与输出 token 总量，用于全局对比。",
    inputSchema: { type: "object", properties: {} },
    run: () => boardText(),
  },
];

// ---- JSON-RPC loop ----------------------------------------------------------

const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const err = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

export async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    case "notifications/initialized":
      return null;
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return err(id, -32602, `unknown tool: ${params?.name}`);
      try {
        return ok(id, await tool.run(params.arguments ?? {}));
      } catch (error) {
        return ok(id, text(`token_speed 工具执行失败：${error.message}`, true));
      }
    }
    default:
      return method?.startsWith("notifications/")
        ? null
        : err(id, -32601, `method not found: ${method}`);
  }
}

export async function readStdin(stdin = process.stdin, stdout = process.stdout) {
  let buffer = "";
  for await (const chunk of stdin) {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        stdout.write(JSON.stringify(err(null, -32700, "parse error")) + "\n");
        continue;
      }
      try {
        const reply = await handle(msg);
        if (reply) stdout.write(JSON.stringify(reply) + "\n");
      } catch (error) {
        stdout.write(JSON.stringify(err(msg?.id ?? null, -32603, error.message)) + "\n");
      }
    }
  }
}

// Start listening only when actually driven over stdio; direct invocation runs
// a self-test so the module can be smoke-tested without an MCP client.
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain && process.env.TOKEN_SPEED_SELFTEST === "1") {
  const snap = currentSpeedSnapshot({
    workingDir: process.env.ZCODE_PROJECT_DIR ?? process.cwd(),
  });
  console.log(
    JSON.stringify(
      {
        session: snap.session.id,
        resolvedBy: snap.session.resolvedBy,
        overall: snap.metrics?.speed.overall ?? null,
        db: snap.db,
      },
      null,
      1
    )
  );
} else if (isMain) {
  // HTTP host starts with the process so the composer chip can always connect.
  startHttpHost().catch((error) => {
    process.stderr.write(`bzs-token-speed http host failed: ${error.message}\n`);
  });
  readStdin().catch((error) => {
    process.stderr.write(`bzs-token-speed fatal: ${error.message}\n`);
    process.exit(1);
  });
}
