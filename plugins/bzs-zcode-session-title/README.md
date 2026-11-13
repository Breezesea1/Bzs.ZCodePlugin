# bzs-zcode-session-title

让 ZCode 的会话标题跟上你正在做的事情。每轮对话结束后，插件自动**总结会话内容**并**重命名会话标题**——先说处理的对象，再说核心目标，会话再多也容易找回。

| 原来的标题 | 总结命名后 |
| --- | --- |
| 查看D:\dy3d\WISH\pipeline和…（被截断的原始输入） | 🔎 pipeline 各仓库｜汇总功能与联系 |
| 查看某个 handoff 文件 | 🧪 Deadline 插件｜核对 0.3.2 交接 |
| 帮我看看这个报错 | 🧩 Workstation 插件｜测试版切换修复 |

标题统一为「类别 emoji + 对象｜核心目标」：对象在前（模块名、工具名或内容主题），目标在后（持续目标而非最后一句）。跟随对话语言，可以暂停，也可以固定某个会话的名称。

## 工作方式（零网关直连宿主全量模型）

1. **Stop Hook 触发**：每轮对话结束（`Stop` 事件），宿主以后台方式派发命名 worker（`async:true`，不阻塞对话；由 `stop_hook_active` 跳过续跑轮防止重复）。
2. **读取会话历史**：worker 直接只读本机 SQLite 会话库（`~/.zcode/cli/db/db.sqlite`），按宿主同源的投影策略筛出真实用户输入与可见助手回复，应用回退记录，取最近 N 轮构造总结上下文。
3. **宿主全量模型目录与多协议直调**：直接读取宿主 ZCode 本地渠道配置（`zcode-builtin.json` + `~/.zcode/v2/provider_config.json` + `credentials.json`），按宿主同构规则还原全部已启用渠道、可用模型、思考档位及 `optionSpecs` 参数映射——**宿主 ZCode 里有什么模型，就能配什么模型**：
   - 支持宿主全部三种协议栈：`anthropic-messages`、`openai-responses`、`openai-chat-completions`（含 JSON 与 SSE 流式响应兼容）。
   - 支持所有个人自定义渠道（如本地聚合代理 `magpie`、自建网关）、内置模板派生渠道（OpenAI、Anthropic、OpenRouter、DeepSeek、MiniMax、Kimi、硅基流动、百炼等）以及已登录的官方账号渠道（`account:bigmodel-*` / `account:zai-*`，自动本地解密凭据并铸造短时项目 token）。
4. **安全改名**：改名直写任务索引（`~/.zcode/v2/tasks-index.sqlite`）的 `cli_title` 官方写入位——与宿主 CLI 会话同款协议，宿主自动镜像到 `title` 列。改名前复查漂移指纹与用户手动改名锁定（`title_overridden`/策略文件双保险），对话中不插入任何消息。

插件**零 npm 依赖、零外部服务、零网关劫持**：仅要求 Node.js 22+（内置 `node:sqlite`）。

## 安装

通过本地插件市场安装后，让 Agent 按 [setup](./skills/setup/SKILL.md) 初始化：核验环境 → 从宿主目录选择任意模型与档位 → doctor 体检 → 启用。

## 配置

配置文件在插件数据目录 `${ZCODE_PLUGIN_DATA}/config.json`，完整字段与范围见 [configuration](./skills/configuration/SKILL.md)：

```jsonc
{
  "selection": {
    "providerId": "magpie",
    "modelId": "bzs/auto/glm-5.3-flash",
    "options": { "reasoningLevel": "low" }   // 填写该模型在宿主目录中实际支持的档位
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

- **查询宿主可用模型**：运行 `node cli.mjs models` 查看宿主当前所有可用 `providerId`、`modelId` 与 `reasoningLevels`。
- **切换模型 / 档位**：[configuration](./skills/configuration/SKILL.md)。
- **暂停 / 恢复**：[control](./skills/control/SKILL.md) 的 `disable` / `enable`。
- **固定标题**：界面手动改名会被自动检测并锁定不再覆盖；`lock` / `unlock` 直接操作策略文件。
- **排障**：[debug](./skills/debug/SKILL.md) 与 `doctor` / `probe` / `status` 命令；日志在数据目录 `state/` 下。

## 命令速查

```bash
node cli.mjs models                                               # 列出宿主 ZCode 当前全部可用渠道、模型与档位
# stdin 传 {"session_id":"...","workspace_path":"..."}
node cli.mjs doctor --config "${ZCODE_PLUGIN_DATA}/config.json"   # 环境/目录/鉴权体检
node cli.mjs probe  --config "${ZCODE_PLUGIN_DATA}/config.json"   # 鉴权与任务索引快速自检
node cli.mjs run --config ...          # 预览（不改名）
node cli.mjs run --apply --config ...  # 执行命名
node cli.mjs lock|unlock|policy --config ...                      # 标题固定策略
```

**已知取舍**：改名写入后，已打开的任务列表依赖宿主下次刷新（窗口聚焦/列表重开）才显示新标题；列表数据本身实时读库，无数据不一致。
