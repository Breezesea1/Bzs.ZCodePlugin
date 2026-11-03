---
name: token-speed
description: 查看当前 ZCode 会话的 token 速度（tok/s）。当用户想看生成速度、解码速率、token/s、首字延迟 TTFT、缓存命中、模型流量统计，或要求打开 Matrix/黑客帝国风格的实时监控仪表盘，或报告输入框旁的速度芯片不显示/异常时使用。
---

# Token Speed — 会话 token 速度观测

速度芯片内联在 ZCode 输入框工具栏（「完全访问」按钮旁），每秒自动刷新，通常无需调用任何工具。MCP 工具用于深入查询。

## 工具速查（服务器名 `bzs-token-speed`）

| 工具 | 用途 |
| --- | --- |
| `token_speed` | 查询当前会话的速度摘要（人类可读文本） |
| `token_speed_detail` | 返回完整结构化 JSON（逐请求样本，用于分析/绘图） |
| `token_speed_dashboard` | 启动 Matrix 风格实时仪表盘并返回本地 URL |
| `token_speed_board` | 全局视角：列出近 1 小时有模型流量的全部会话 |

## 使用规则

1. **"看看现在的 token 速度" / "速度多快"** → 直接调用 `token_speed`，把返回的速度数字、TTFT 和状态复述给用户。不要运行任何 shell 命令去读数据库——工具已经做了只读查询和统计。
2. **"打开仪表盘" / "Matrix 界面" / "实时监控"** → 调用 `token_speed_dashboard`，把返回的 `http://127.0.0.1:<port>/` 作为 Markdown 链接交给用户点击打开。服务在 MCP 进程存续期间常驻，重复调用不会重复建端口。
3. **需要原始数据画图、或用户要求"详细数据"** → 调用 `token_speed_detail` 并解析 JSON。速度口径：`output_tokens ÷ (completed_at − first_token_at)`，即解码速度；加权平均按 token 数加权而非算术平均。
4. **"其它会话" / "哪个会话最快" / "全局"** → 调用 `token_speed_board`。若用户点名某个会话，把其 `sessionId` 传入 `token_speed` 的 `session_id` 参数。
5. **芯片排错**（用户报告"速度显示 —"或"芯片不见了"）：
   - 芯片挂在输入框工具栏 `[data-composer-leading-content]` 内，靠 `composer/chip.mjs` 注入脚本渲染；该脚本由 `scripts/install.mjs` 写入 app.asar。
   - 排错顺序：`node scripts/status.mjs` 查 `chipInjected` 与 `httpHostReachable`；两者都 true 仍异常时，让用户重启 ZCode（注入脚本只在渲染器启动时加载）。
   - 修复/重装：先运行插件 MCP 任意工具（让 http-port.json 写入端口），再 `node scripts/install.mjs`。
6. **数据口径说明**（回答用户追问时使用）：
   - 速度只统计 `status='completed'` 的请求；单请求样本 `<50ms` 或 `0 token` 的被剔除。
   - `latest` 是最新一次请求的解码速度；`recent10m` 是最近 10 分钟按 token 加权；`overall` 是整个会话加权。
   - TTFT 为 `first_token_at − started_at`，受缓存与排队影响，与解码速度独立。
   - 会话识别：优先 `session_id` 参数，否则按工作目录 + 最近模型流量推断交互式会话。多窗口同时活跃时芯片可能显示别的窗口的速度（tooltip 里有会话号可核对）。

## 回复格式建议

速度数字保留 1 位小数；`streaming` 为 true 时说明"正在流式输出"。不要虚构仪表盘 URL——必须以工具返回的 URL 为准。
