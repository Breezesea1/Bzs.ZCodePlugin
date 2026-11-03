---
name: setup
description: 初始化、升级或卸载 ZCode 会话自动总结与重命名，配置外置数据目录并验证链路。
---

# 自动总结命名安装与配置

原生插件根为 `${ZCODE_SKILL_DIR}/../..`；Hook 与技能由宿主加载，配置与状态保存在插件数据目录 `${ZCODE_PLUGIN_DATA}`。

1. 环境核验：确认 Node.js 20+ 与 sqlite3 CLI 可用（`node --version`、`sqlite3 --version`）。sqliteBin 解析顺序：config.json 的 `sqliteBin` → 环境变量 `SQLITE_BIN` → PATH；显式无效路径不回退。本插件零 npm 依赖（ws 与 RPC 协议已 vendor 进插件），不需要 `npm install`。
2. 依赖网关：本插件通过公共网关（suian-zcode-common 的 suian-zcode-gateway）连接原 ZCode 窗口完成改名与模型调用。若尚未配置，先按公共 skill [suian-zcode-common:setup] 安装或重载网关；Desktop 需开启「移动端远程控制」面板（不需要手机扫码）。
3. 初始化配置：仅当 `${ZCODE_PLUGIN_DATA}/config.json` 不存在时，从插件根 `config.example.json` 复制并把 `enabled` 设为 `false`（首次保持暂停，等模型选择完成后再启用）。已有配置保留原开关、模型选择与自定义字段，不因重复安装而重置。配置字段详见 [configuration](../configuration/SKILL.md)。
4. 选择模型与档位：运行 `node "{{plugin_root}}/cli.mjs" models --config "{{ZCODE_PLUGIN_DATA}}/config.json"`（stdin 传 `{}`）取实际可用模型目录，列出 providerId、modelId 与支持档位，由用户选择后写回 `selection`；取不到目录（网关未就绪）时保持暂停并报告待确认项。
5. 验证：stdin 传 `{"session_id":"<当前会话ID>","workspace_path":"<当前工作区>"}` 运行 `node cli.mjs doctor --config ...`，检查 history / gateway / model_catalog 三项；再运行 `probe`。全部通过后执行 `enable`，并运行一次 `node cli.mjs run --apply --config ...`（同一 stdin）做端到端确认。

首次环境未就绪时，交付本机配置与待验证报告，最后提示用户在桌面端开启远控面板后重试，不在当前会话外做任何全局改动。

## 升级

通过原生插件管理器更新本插件后，从新插件清单获取路径，重跑同一初始化与 doctor 命令。保留配置、状态与标题锁；不做数据迁移。

## 卸载

通过原生插件管理器停用或卸载本插件即可：Hook 与技能由宿主随插件移除。`${ZCODE_PLUGIN_DATA}` 下的配置与状态目录会保留，用户可手动清理；公共网关属公共插件，不在本插件卸载范围内处理。
