---
name: setup
description: 初始化、升级或卸载 ZCode 会话自动总结与重命名，配置外置数据目录并验证链路。
---

# 自动总结命名安装与配置

原生插件根为 `${ZCODE_SKILL_DIR}/../..`；Hook 与技能由宿主加载，配置与状态保存在插件数据目录 `${ZCODE_PLUGIN_DATA}`。

1. 环境核验：确认 Node.js 22+（需内置 `node:sqlite`，`node --version`）。会话库与任务索引由 `node:sqlite` 直接读写，不需要 sqlite3 CLI。本插件零 npm 依赖、零外部服务，不需要 `npm install`。
2. 直连前提：本插件直接读取本机数据层与宿主渠道配置——读会话库（`~/.zcode/cli/db/db.sqlite`）、写任务索引（`~/.zcode/v2/tasks-index.sqlite`）、从宿主 `zcode-builtin.json` + `~/.zcode/v2/provider_config.json` + `credentials.json` 还原完整可用模型目录，并按目标渠道协议（`anthropic-messages` / `openai-responses` / `openai-chat-completions`）直接调用模型端点。不需要网关、不需要远控面板、不需要额外在插件里重复配置 API key。**禁止任何形式的网关/relay 劫持方案**。
3. 选择模型与档位：运行 `node "{{plugin_root}}/cli.mjs" models`（stdin 传 `{}`）读取宿主 ZCode 当前已启用的全部渠道、模型 ID 与支持档位，供用户选择目标 `providerId` / `modelId` / `reasoningLevel`。
4. 初始化配置：若 `${ZCODE_PLUGIN_DATA}/config.json` 不存在，写入包含用户所选 `selection` 的配置（若尚未确认模型，先从 `config.example.json` 复制并设 `"enabled": false`）。已有配置保留原开关、模型选择与自定义字段，不因重复安装而重置。配置字段详见 [configuration](../configuration/SKILL.md)。
5. 验证：stdin 传 `{"session_id":"<当前会话ID>","workspace_path":"<当前工作区>"}` 运行 `node cli.mjs doctor --config ...`，检查 selection / history / task_index / model_catalog / credentials 五项；再运行 `probe`。全部通过后执行 `enable`，并运行一次 `node cli.mjs run --apply --config ...`（同一 stdin）做端到端确认。

首次环境未就绪时，交付本机配置与待验证报告，不在当前会话外做任何全局改动。

## 升级

通过原生插件管理器更新本插件后，重跑 `models` 与 `doctor` 核对所选 `selection` 是否在宿主当前可用模型目录中。旧版配置残留的 `sqliteBin`、`gateway`、`model` 字段会自动忽略。

## 卸载

通过原生插件管理器停用或卸载本插件即可：Hook 与技能由宿主随插件移除。`${ZCODE_PLUGIN_DATA}` 下的配置与状态目录会保留，用户可手动清理。
