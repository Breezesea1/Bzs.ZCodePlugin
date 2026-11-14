# TokenPulse (`bzs-token-speed`)

在 ZCode 输入框工具栏内联显示当前会话的实时 token 速率（tok/s）、状态脉搏、逐请求走势线与交互式 HUD 悬浮详情面板；附 3 个零依赖 MCP 查询工具。

## 架构

```
lib/
  db.mjs          存储层：db.sqlite 只读访问（model_usage 历史 + message/part 实时流式）
  sessions.mjs    会话推断：显式 id > 目录匹配 > 全局最近
  metrics.mjs     指标引擎：三模态速率消歧（stream / vis-stream / e2e）、实时流式检测、纯函数
  service.mjs     组合根：currentSpeedSnapshot / sessionSpeedSnapshot / activeSessions
server/
  http.mjs        传输层：loopback HTTP（/api/snapshot?session=... /api/board /api/ping），支持端口 47816 自动接管
  mcp.mjs         传输层：MCP stdio + 启动自愈注入检测
composer/
  chip.mjs        呈现层：多窗格精确绑定 [data-session-id]、响应式折叠、逐请求走势线与悬浮/固定详情面板
scripts/
  lib/asar.mjs    asar 局部头读取与字节级单文件替换（兼容 Windows 运行时热写）
  lib/target.mjs  注入标记、芯片版本哈希与清理逻辑
  install.mjs     幂等注入 app.asar（同时供 MCP 启动自愈调用）
  uninstall.mjs   跨版本安全原位剥离还原（绝不用旧版备份降级新版客户端）
  status.mjs      查看注入状态、版本匹配度与后端可达性
tests/
  token-speed.test.mjs  核心指标消歧、实时流式状态、注入幂等与 HTTP/MCP 单元测试
```

## 核心特性

1. **三模态速率消歧（拒绝虚高假峰值）**
   - **`stream`（流式解码）**：首 token 即开始流式传输（含流式思考模型），按 `output_tokens / (completed_at - first_token_at)` 计算，并记录纯净网络/预填充 TTFT。
   - **`vis-stream`（思考后流式）**：针对服务端静默完成 `reasoning_tokens` 后才打 `first_token_at` 并流式输出可见文本的场景，按 `(output_tokens - reasoning_tokens) / (completed_at - first_token_at)` 计算可见流式速率。
   - **`e2e`（端到端吞吐）**：针对代理整包缓冲或思考数十秒后百毫秒内单包冲刷 tool-call JSON 的场景，回退 `output_tokens / duration_ms`，彻底消除上千 `tok/s` 的失真数值。
2. **窗格级精确会话绑定与实时态反馈**
   - 直接读取每个输入框所属会话容器的 `[data-session-id]`（支持分屏多窗格与新建 `draft` 会话隔离），切换会话即时切换数据。
   - 结合 SQLite WAL 中的最新未完成 `message/part` 与渲染器 `[data-projection-seq]`，实时呈现 **思考中（含计时/流式速率）**、**流式输出**、**工具执行** 与 **空闲** 四种状态。
3. **原生级 UI 与交互式详情 HUD**
   - 完整复用 ZCode `--color-*` 主题语义变量（自适应深浅色主题）与 `data-composer-collapse-priority="extension"` 窄屏自动折叠协议。
   - 悬停或点击芯片可展开/固定详情卡片：四维指标网格、最近 24 次请求逐根悬停柱状图、缓存命中进度条与推理/输入/输出用量汇总。
4. **ZCode 升级自愈与跨版本安全卸载**
   - MCP 服务启动时仅读取 `app.asar` 头部快速校验芯片哈希；若 ZCode 客户端升级覆盖了 `app.asar`，后台自动重新注入（刷新/重启一次窗口即生效）。
   - `uninstall.mjs` 默认原位剥离注入片段，并自动清理跨版本的过期备份，杜绝旧版 `app.asar.orig` 覆盖新版客户端。
