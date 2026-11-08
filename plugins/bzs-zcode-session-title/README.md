# bzs-zcode-session-title

让 ZCode 的会话标题跟上你正在做的事情。每轮对话结束后，插件自动**总结会话内容**并**重命名会话标题**——先说处理的对象，再说核心目标，会话再多也容易找回。

| 原来的标题 | 总结命名后 |
| --- | --- |
| 查看D:\dy3d\WISH\pipeline和…（被截断的原始输入） | 🔎 pipeline 各仓库｜汇总功能与联系 |
| 查看某个 handoff 文件 | 🧪 Deadline 插件｜核对 0.3.2 交接 |
| 帮我看看这个报错 | 🧩 Workstation 插件｜测试版切换修复 |

标题统一为「类别 emoji + 对象｜核心目标」：对象在前（模块名、工具名或内容主题），目标在后（持续目标而非最后一句）。跟随对话语言，可以暂停，也可以固定某个会话的名称。

## 工作方式（0.3.0 起直连，无网关）

1. **Stop Hook 触发**：每轮对话结束（`Stop` 事件），宿主以后台方式派发命名 worker（`async:true`，不阻塞对话；由 `stop_hook_active` 跳过续跑轮防止重复）。
2. **读取会话历史**：worker 直接只读本机 SQLite 会话库（`~/.zcode/cli/db/db.sqlite`），按宿主同源的投影策略筛出真实用户输入与可见助手回复，应用回退记录，取最近 N 轮构造总结上下文。
3. **模型总结**：直接调用 Anthropic 兼容端点（bigmodel/zai 家族，零中间层）。凭据从 Desktop 凭据文件本地解密（AES-256-GCM），按宿主同款协议铸造短时项目 token（约 5 小时，自动临期重铸），计费走你的 coding plan。
4. **安全改名**：改名直写任务索引（`~/.zcode/v2/tasks-index.sqlite`）的 `cli_title` 官方写入位——与宿主 CLI 会话同款协议，宿主自动镜像到 `title` 列。改名前复查漂移指纹与用户手动改名锁定（`title_overridden`/策略文件双保险），对话中不插入任何消息。

插件**零 npm 依赖、零外部服务**：不需要网关、不需要远控面板、不需要 API key 配置。仅要求 Node.js 22+（内置 `node:sqlite`）与 sqlite3 CLI（读会话库）。

### 模型家族（0.3.2）

直连支持三家族：**bigmodel**（magpie/GLM，铸 token）、**zai**（铸 token）、**minimax**（`MiniMax-M3.1-Flash` / `MiniMax-M3`，静态 API key，凭据名 `oauth:minimax:api_key`，用 `scripts/set-minimax-key.mjs` 写入）。

### 关于 gateway/ 目录（实验性，勿启用）

仓库内保留一份实验性网关代码（照抄 suian 方案：本地 WS 中继 Desktop↔官方 relay，借宿主 `model-selection.getView` 模型目录生成）。**默认不启用，也不建议启用**：安装器会写用户级环境变量把 Desktop 远控 relay 指向本地网关，若网关到官方上游的认证失败，**会连带弄坏 ZCode 手机远控**（2026-11-08 实测：上游 1006 → `relay-unavailable`）。`config.gateway.mode` 支持 `auto`(缺省)/`gateway`/`direct`；当前线上配置为 `direct`。

## 安装

通过本地插件市场安装后，让 Agent 按 [setup](./skills/setup/SKILL.md) 初始化：核验环境 → 选择模型与档位 → doctor 体检 → 启用。

## 配置

配置文件在插件数据目录 `${ZCODE_PLUGIN_DATA}/config.json`，完整字段与范围见 [configuration](./skills/configuration/SKILL.md)：

```jsonc
{
  "selection": {                       // 总结模型（必填；providerId 需含 bigmodel/magpie/glm 或 zai）
    "providerId": "magpie",
    "modelId": "GLM-5.3-Flash",
    "options": { "reasoningLevel": "low" }   // minimal / low / medium / high
  },
  "enabled": true,
  "timeoutMs": 120000,
  "maxOutputTokens": 2048,
  "rename": {
    "requireFormat": true,             // 强制「emoji 对象｜目标」结构
    "maxTitleChars": 48,
    "minTitleChars": 6,
    "maxTurns": 6                      // 送入模型的最近对话轮数
  }
}
```

## 日常操作

- **暂停 / 恢复**：[control](./skills/control/SKILL.md) 的 `disable` / `enable`。
- **固定标题**：界面手动改名会被自动检测并锁定不再覆盖；`lock` / `unlock` 直接操作策略文件。
- **排障**：[debug](./skills/debug/SKILL.md) 与 `doctor` / `probe` / `status` 命令；日志在数据目录 `state/` 下。

## 命令速查

```bash
# stdin 传 {"session_id":"...","workspace_path":"..."}
node cli.mjs doctor --config "${ZCODE_PLUGIN_DATA}/config.json"   # 环境/链路体检
node cli.mjs models --config ...                                  # 可用模型目录与档位
node cli.mjs run --config ...          # 预览（不改名）
node cli.mjs run --apply --config ...  # 执行命名
node cli.mjs lock|unlock|policy --config ...                      # 标题固定策略
```

## 已验证范围

- 单元测试 66 项（标题校验、命名状态机、配置校验、SQLite 历史读取、hook 派发、CLI 集成、直连目录校验、prompt 渲染、模型家族与网关回落）。
- 真实链路端到端验证（2026-11-08）：真实会话 9 轮 → 凭据解密与项目 token 铸造 → GLM-5.3-Flash 直调总结 → rename 落地任务索引 `cli_title` 位（宿主自动镜像）→ 次轮读回确认后 keep。`doctor` 五项检查全绿。
- 指纹漂移护栏：会话在总结期间继续变化时正确返回 `stale_result` 而不覆盖。
- 用户手动改名保护：`title_overridden=1` 的行直写让位，策略文件锁定互为补充。

**已知取舍**：改名写入后，已打开的任务列表依赖宿主下次刷新（窗口聚焦/列表重开）才显示新标题；列表数据本身实时读库，无数据不一致。
