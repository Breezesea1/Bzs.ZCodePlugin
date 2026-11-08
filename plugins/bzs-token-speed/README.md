# bzs-token-speed

在 ZCode 输入框工具栏内联显示当前会话的 token 解码速度（tok/s）与 40 秒走势线。附 3 个 MCP 查询工具。

## 架构

```
lib/
  db.mjs          存储层：db.sqlite 只读访问（唯一知道 schema 的模块）
  sessions.mjs    会话推断：显式 id > 目录匹配 > 全局最近
  metrics.mjs     指标计算：纯函数，无 IO，now 注入
  service.mjs     组合根：currentSpeedSnapshot / sessionSpeedSnapshot / activeSessions
server/
  http.mjs        传输层：loopback HTTP（/api/snapshot /api/board /api/ping），随进程启动
  mcp.mjs         传输层：MCP stdio + 4 个工具（自实现 JSON-RPC，零依赖）
composer/
  chip.mjs        呈现层：注入 ZCode 渲染器的自包含芯片脚本（只管显示）
scripts/
  lib/asar.mjs    asar 读写库：字节级替换单文件，其余文件原样保留
  lib/target.mjs  注入标记与常量
  install.mjs     注入芯片到 app.asar（自动备份，幂等）
  uninstall.mjs   还原（优先用备份还原，逐字节一致）
  status.mjs      查看注入状态与后端可达性

skills/token-speed/SKILL.md  使用技能
```

数据流：`db.sqlite → lib（引擎）→ server/http.mjs（每秒可拉取的 JSON）→ chip.mjs（1s 轮询渲染）`。
MCP 工具走 `lib → server/mcp.mjs`，与 HTTP 共享引擎但不共享传输。

## 速度口径

- 单请求速度 = `output_tokens / ((completed_at − first_token_at)/1000)`；`first_token_at` 缺失回退 `duration_ms`；窗口 <50ms 或 0 token 的样本剔除。
- 加权均值 = Σtokens / Σtime（不是算术平均）。
- TTFT = `first_token_at − started_at`，与解码速度独立。
- 行只在请求完成时写入，无 in-flight 数据；`streaming` 由"最新完成请求 <3s"近似。

## 内联芯片原理（重要）

ZCode 没有官方的底栏/statusline 扩展点（hook 事件枚举里没有 UI 事件；插件 UI bridge 只能渲染聊天流卡片）。芯片通过 `scripts/install.mjs` 把 `composer/chip.mjs` 注入 `app.asar` 里的 `out/renderer/index.html`：

- 注入段用 `<!-- bzs-token-speed:begin/end -->` 标记包围，重复安装自动去旧换新。
- 端点以 `<meta name="bzs-token-speed-base">` 写入同一文件；HTTP 服务启动时把端口写到 `resources/bzs-token-speed-backup/http-port.json`。多会话会各自拉起 MCP 进程，只有第一个占到固定端口 47816，其余回退随机端口——回退实例若探到固定端口有应答，就仍然记录 47816，避免把文件覆盖成随自己进程消失的临时端口。
- 芯片复用 ZCode 自带 Tailwind 类（`h-7 rounded-lg text-foreground-subtle` 等），挂载点是 composer 工具栏 `[data-composer-leading-content]`（「完全访问」按钮同一行）。
- Electron fuse `EnableEmbeddedAsarIntegrityValidation` 为关闭状态（已实测 3.16.3），否则此方案不可行。

## 安装 / 更新 / 卸载

1. 安装并启用本插件（ZCode 插件市场 → 本地市场）。
2. 随便让插件 MCP 跑一次（如在会话里调用 `token_speed`），生成端口文件。
3. `node plugins/bzs-token-speed/scripts/install.mjs`
4. 重启 ZCode。芯片出现在输入框工具栏。

更新插件后重跑 install.mjs（标记保证幂等）。卸载：先 `scripts/uninstall.mjs`，再在 UI 里移除插件。

## 已验证（2026-10-30，ZCode 3.16.3）

- MCP stdio 全链路（initialize/tools/list/4×tools/call）实测通过。
- HTTP `/api/snapshot` `/api/board` `/api/ping` 带 CORS 头实测通过。
- asar 替换往返：27772 个文件字节级 0 差异；install → status → uninstall 后与原始档逐字节一致。
- 芯片在注入页面中点亮：数值、sparkline、tooltip、流式强调均正常（内置浏览器 DOM 审计）。
- SQLite 只读连接（WAL）亚秒级可见新数据；路径必须用正斜杠。
- `node:sqlite` 的 IN 列表 + LIMIT 混合参数绑定有怪癖（datatype mismatch），LIMIT 用内插数字规避。

## 已知边界

- 多窗口同时活跃时，芯片显示"目录 + 最近模型流量"推断出的冠军会话，tooltip 有会话号可核对。
- ZCode 升级会重写 app.asar，需重跑 install.mjs（升级后先查 `PRAGMA table_info(model_usage)` 列名是否变化：`first_token_at/completed_at/output_tokens`）。
- 若未来版本开启 asar 完整性校验 fuse，内联芯片方案失效，但 MCP 工具不受影响。
