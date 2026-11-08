// 网关安装与启动：生成 config.json（端口+control_token）、注册登录自启（启动文件夹 VBS）、
// 可选立即拉起。网关进程是常驻独立进程，部署路径 = 本插件缓存目录（无缓存外复制；
// 插件升级走市场更新，网关随插件版本一起更新，与 suian 的缓存外部署相比放弃了
// "插件缓存被清仍存活"特性，换取零拷贝单一来源）。
//
// 用法：
//   node scripts/install-gateway.mjs --status      # 查看安装状态与运行健康
//   node scripts/install-gateway.mjs               # 写配置 + 注册自启 + 立即启动
//   node scripts/install-gateway.mjs --no-start    # 写配置 + 注册自启，不立即启动
//   node scripts/install-gateway.mjs --uninstall   # 移除自启 + 停止运行中的网关
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, appendFileSync, openSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const HERE = dirname(dirname(fileURLToPath(import.meta.url))); // 插件根
const GATEWAY_ENTRY = join(HERE, "gateway", "gateway.mjs");
const DEFAULT_PORT = 17329;
const CONFIG_DIR = join(homedir(), ".zcode", "bzs-zcode-session-title", "gateway");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const LOG_DIR = join(CONFIG_DIR, "logs");
const STARTUP_VBS = join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
  "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "bzs-title-gateway.vbs");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--status") out.status = true;
    else if (argv[i] === "--no-start") out.noStart = true;
    else if (argv[i] === "--uninstall") out.uninstall = true;
    else if (argv[i] === "--port") out.port = Number(argv[++i]);
    else throw new Error(`未知参数：${argv[i]}`);
  }
  return out;
}

function health(port, timeoutMs = 2000) {
  // 同步上下文里用 atexit 式子进程做同步 fetch 的替代：直接用 spawnSync + node -e
  const script = `fetch('http://127.0.0.1:${port}/health',{signal:AbortSignal.timeout(${timeoutMs})}).then(r=>r.json()).then(h=>console.log(JSON.stringify(h))).catch(()=>process.exit(1))`;
  const res = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: timeoutMs + 1000 });
  if (res.status !== 0) return null;
  try { return JSON.parse(res.stdout); } catch { return null; }
}

function findNode() {
  // VBS 自启需要绝对路径；优先当前运行时
  if (process.execPath && existsSync(process.execPath)) return process.execPath;
  return "node.exe";
}

function writeVbs(nodeExe) {
  // 无窗口常驻；stdout/stderr 落日志文件供排障
  const vbs = [
    'Set shell = CreateObject("WScript.Shell")',
    `Set fso = CreateObject("Scripting.FileSystemObject")`,
    `If Not fso.FolderExists("${LOG_DIR.replace(/\\/g, "\\\\")}") Then fso.CreateFolder("${LOG_DIR.replace(/\\/g, "\\\\")}")`,
    `shell.Run """${nodeExe.replace(/\\/g, "\\\\")}"" ""${GATEWAY_ENTRY.replace(/\\/g, "\\\\")}"" --config ""${CONFIG_FILE.replace(/\\/g, "\\\\")}"" >> ""${LOG_DIR.replace(/\\/g, "\\\\")}\\gateway.out.log"" 2>> ""${LOG_DIR.replace(/\\/g, "\\\\")}\\gateway.err.log""", 0, False`,
  ].join("\r\n");
  mkdirSync(dirname(STARTUP_VBS), { recursive: true });
  writeFileSync(STARTUP_VBS, vbs);
}

function status() {
  const installed = existsSync(CONFIG_FILE);
  const vbs = existsSync(STARTUP_VBS);
  let config = null;
  if (installed) { try { config = JSON.parse(readFileSync(CONFIG_FILE, "utf8")); } catch {} }
  const h = config ? health(config.port) : null;
  console.log(JSON.stringify({
    configInstalled: installed, configPath: CONFIG_FILE,
    startupRegistered: vbs, startupPath: STARTUP_VBS,
    port: config?.port ?? null,
    running: !!h, health: h ? {
      desktop_connected: h.desktop_connected, upstream_connected: h.upstream_connected,
      paired: h.paired, local_clients: h.local_clients, version: h.build?.version
    } : null,
  }, null, 2));
}

const args = parseArgs(process.argv.slice(2));
if (args.status) { status(); process.exit(0); }

// Desktop 通过这个用户级环境变量把远控连接指向本地网关（主进程启动时读取，改后需重开 ZCode）。
const RELAY_URL_ENV = "ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL";
function writeRelayEnv(port) {
  const url = `ws://127.0.0.1:${port}/ws`;
  const current = process.env[RELAY_URL_ENV];
  if (current === url) return { url, changed: false };
  // 照抄 suian setup.ps1 的两步：写 HKCU\Environment + 广播 WM_SETTINGCHANGE。
  // 只 setx 不广播时，Explorer 环境块仍是旧值，从任务栏启动的 ZCode 继承不到新 URL。
  const ps = [
    `[Environment]::SetEnvironmentVariable('${RELAY_URL_ENV}','${url}','User')`,
    `Add-Type -Namespace Bzs -Name EnvBroadcast -MemberDefinition '[DllImport("user32.dll", EntryPoint="SendMessageTimeoutW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wparam, string area, uint flags, uint timeout, out UIntPtr result);'`,
    `[UIntPtr]$result=[UIntPtr]::Zero; [Bzs.EnvBroadcast]::SendMessageTimeout([IntPtr]65535, 26, [UIntPtr]::Zero, 'Environment', 2, 1000, [ref]$result) | Out-Null`,
  ].join("; ");
  const res = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", timeout: 15000 });
  if (res.status !== 0) throw new Error("环境变量写入/广播失败：" + (res.stderr || res.stdout));
  return { url, changed: true };
}

if (args.uninstall) {
  if (existsSync(STARTUP_VBS)) rmSync(STARTUP_VBS);
  const config = existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, "utf8")) : null;
  if (config) spawnSync(process.execPath, ["-e",
    `fetch('http://127.0.0.1:${config.port}/shutdown',{method:'POST',headers:{Authorization:'Bearer ${config.control_token}'}}).catch(()=>{})`],
    { encoding: "utf8", timeout: 4000 });
  // 移除 relay 指向：恢复官方直连
  spawnSync("reg", ["delete", "HKCU\\Environment", "/v", RELAY_URL_ENV, "/f"], { encoding: "utf8" });
  console.log(JSON.stringify({ removed: { startup: true, shutdownRequested: !!config, relayEnvCleared: true } }));
  process.exit(0);
}

// 安装 / 更新
mkdirSync(CONFIG_DIR, { recursive: true });
mkdirSync(LOG_DIR, { recursive: true });
let config = existsSync(CONFIG_FILE) ? (() => { try { return JSON.parse(readFileSync(CONFIG_FILE, "utf8")); } catch { return null; } })() : null;
const port = args.port ?? config?.port ?? DEFAULT_PORT;
if (!config || typeof config.control_token !== "string") {
  config = { version: 1, port, control_token: randomBytes(24).toString("base64url"), instance_id: "bzs-session-title" };
} else { config.port = port; }
writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
writeVbs(findNode());

let started = null;
const relayEnv = writeRelayEnv(port);
if (!args.noStart) {
  const existing = health(config.port);
  if (existing) {
    started = { alreadyRunning: true, port: config.port };
  } else {
    const out = openSyncAppend();
    const child = spawn(process.execPath, [GATEWAY_ENTRY, "--config", CONFIG_FILE],
      { detached: true, stdio: ["ignore", out, out] });
    child.unref();
    // 等健康检查就绪（最多 10s；Desktop 未连接属正常，网关本身应响应）
    let up = null;
    for (let i = 0; i < 20 && !up; i++) {
      await new Promise(r => setTimeout(r, 500));
      up = health(config.port, 1500);
    }
    started = { started: true, port: config.port, pid: child.pid, responsive: !!up };
  }
}
console.log(JSON.stringify({ configPath: CONFIG_FILE, startupPath: STARTUP_VBS, relayEnv, ...started }, null, 2));

function openSyncAppend() {
  // detached 子进程的日志句柄：追加模式打开，父进程退出后由子进程持有
  return openSync(join(LOG_DIR, "gateway.out.log"), "a");
}
