# bzs-zcode-session-title

让 ZCode 的会话标题跟上你正在做的事情。每轮对话结束后，插件自动**总结会话内容**并**重命名会话标题**——先说处理的对象，再说核心目标，会话再多也容易找回。

| 原来的标题 | 总结命名后 |
| --- | --- |
| 查看D:\dy3d\WISH\pipeline和…（被截断的原始输入） | 🔎 pipeline 各仓库｜汇总功能与联系 |
| 查看某个 handoff 文件 | 🧪 Deadline 插件｜核对 0.3.2 交接 |
| 帮我看看这个报错 | 🧩 Workstation 插件｜测试版切换修复 |

标题统一为「类别 emoji + 对象｜核心目标」：对象在前（模块名、工具名或内容主题），目标在后（持续目标而非最后一句）。跟随对话语言，可以暂停，也可以固定某个会话的名称。

## 工作方式

1. **Stop Hook 触发**：每轮对话结束（`Stop` 事件），宿主以后台方式派发命名 worker（`async:true`，不阻塞对话；由 `stop_hook_active` 跳过续跑轮防止重复）。
2. **读取会话历史**：worker 直接读本机 SQLite 会话库（`~/.zcode/cli/db/db.sqlite`），按宿主同源的投影策略筛出真实用户输入与可见助手回复，应用回退记录，取最近 N 轮构造总结上下文。
3. **模型总结**：通过公共网关（[suian-zcode-common](../suian-zcode-common/SKILL.md) 的 suian-zcode-gateway）调用你账号里**所选的模型与思考档位**，由模型决定 keep 或 rename。
4. **安全改名**：改名前复查宿主任务元与漂移指纹，防止覆盖用户手动改名；改名经宿主 `renameTask` 完成，对话中不插入任何消息。

插件**零 npm 依赖**：WebSocket（ws 8.22.0，MIT）与 RPC 协议编解码均已 vendor 进插件目录（见 `vendor/` 与许可文件），Node.js 20+ 与 sqlite3 CLI 即可运行。

## 安装

通过本地插件市场安装后，让 Agent 按 [setup](./skills/setup/SKILL.md) 初始化：核验环境 → 配置网关连接 → 选择模型与档位 → doctor 体检 → 启用。桌面端需开启「移动端远程控制」面板（不需要手机扫码）。

## 配置

配置文件在插件数据目录 `${ZCODE_PLUGIN_DATA}/config.json`，完整字段与范围见 [configuration](./skills/configuration/SKILL.md)：

```jsonc
{
  "selection": {                       // 总结模型（必填，来自 models 命令的实际目录）
    "providerId": "magpie",
    "modelId": "bzs/group/glm-5.3-flash",
    "options": { "reasoningLevel": "low" }   // low / high / max …
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
- **固定标题**：界面手动改名会被自动检测并锁定不再覆盖；`lock` / `unlock` 直接操作策略文件（与 suian-zcode-title 插件互认）。
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

- 单元测试 56 项全通过（标题校验、命名状态机、配置校验、SQLite 历史读取、hook 派发、CLI 集成、网关瞬断重试、prompt 渲染）。
- 真实链路端到端验证：读取真实会话 → 模型总结（GLM-5.3-Flash / low）→ keep 路径与 rename 路径 → `renameTask` 落地会话库与任务索引双库。
- 指纹漂移护栏：会话在总结期间继续变化时正确返回 `stale_result` 而不覆盖。
- 网关瞬断自愈：`gateway_rpc_protocol_error` 时自动断开重连并退避重试（10s / 30s）。

**注意**：改名与模型调用依赖公共网关连接原 Desktop 窗口；目标会话所在工作区必须在该窗口打开，且 ZCode 3.16 在线模式下需要官方远控服务可达。离线模式下后台命名不可用（与官方移动端远控一致的约束）。
