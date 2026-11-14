---
name: token-speed
description: 查看当前 ZCode 会话的 token 速度（tok/s）。当用户想看生成速度、解码速率、token/s、首字延迟 TTFT、缓存命中、模型流量统计，或报告输入框旁的速度芯片不显示/异常时使用。
---

# TokenPulse — 会话 Token 速率与流式观测

`TokenPulse` 芯片内联在每个 ZCode 会话输入框工具栏内，精确绑定所属窗格的 `data-session-id`，实时展示思考/流式/工具状态、逐请求速率走势线与交互式详情悬浮面板（悬停查看或点击固定）。MCP 工具用于对话内深入查询。

## 工具速查（服务器名 `bzs-token-speed`）

| 工具 | 用途 |
| --- | --- |
| `token_speed` | 查询当前会话的速度摘要、缓存命中率与实时状态（人类可读文本） |
| `token_speed_detail` | 返回完整结构化 JSON（逐请求样本、解码模式分类、实时状态，用于分析/绘图） |
| `token_speed_board` | 全局视角：列出近 1 小时有模型流量的全部会话 |

## 使用规则

1. **"看看现在的 token 速度" / "速度多快"** → 直接调用 `token_speed`，把返回的速度数字、模式、TTFT、缓存命中率和状态复述给用户。无需用 shell 去读数据库。
2. **需要原始数据画图、或用户要求"详细数据"** → 调用 `token_speed_detail` 并解析 JSON。
3. **"其它会话" / "哪个会话最快" / "全局"** → 调用 `token_speed_board`。若用户点名某个会话，把其 `sessionId` 传入 `token_speed` 的 `session_id` 参数。
4. **芯片排错**（用户报告"芯片不见了"或"客户端刚升级后没显示"）：
   - MCP 服务启动时会自动检测并自愈注入 `app.asar`（无需手工重跑脚本），但注入发生在渲染器已启动之后时，只需按 `Ctrl+R` 刷新或重启一次 ZCode 窗口即可加载最新芯片。
   - 如需核查注入状态：运行 `node scripts/status.mjs` 查看 `chipInjected`、`chipUpToDate` 与 `httpHostReachable`；也可手动执行 `node scripts/install.mjs`。
5. **数据口径说明**：
   - 自动识别三类请求模式，避免将前置隐式思考或末尾单包 JSON 冲刷误算为上千 `tok/s`：
     - `stream`（流式解码）：含流式思考或纯文本流式，`output_tokens ÷ (completed_at − first_token_at)`。
     - `vis-stream`（思考后流式）：服务端静默思考后再流式输出可见文本，`(output_tokens − reasoning_tokens) ÷ (completed_at − first_token_at)`。
     - `e2e`（端到端吞吐）：非流式缓冲或单包工具调用冲刷，`output_tokens ÷ duration_ms`。
   - 加权平均按 `ΣrateTokens ÷ ΣrateMs` 计算，而非算术平均。
   - 实时生成期间基于最新未完成 `part` 行估算实时阶段（`thinking` / `streaming` / `tool`）与近似流式速率，步骤完成后自动切换为 `model_usage` 精确值。

## 回复格式建议

速度数字保留 1 位小数；说明当前所处阶段（空闲 / 思考中 / 流式输出中 / 工具执行中）。
