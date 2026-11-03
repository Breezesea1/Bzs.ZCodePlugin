---
name: control
description: 暂停或恢复 ZCode 自动总结命名，固定、解除固定或查询指定会话的标题策略；不手动改名。
---

# 暂停、恢复与标题固定

所有命令通过 CLI 执行，stdin 传会话事件：`{"session_id":"<会话ID>","workspace_path":"<工作区>"}`。

```bash
node "{{plugin_root}}/cli.mjs" disable --config "{{ZCODE_PLUGIN_DATA}}/config.json"   # 暂停（写 enabled:false）
node "{{plugin_root}}/cli.mjs" enable  --config "{{ZCODE_PLUGIN_DATA}}/config.json"   # 恢复
node "{{plugin_root}}/cli.mjs" lock   --config "{{ZCODE_PLUGIN_DATA}}/config.json"    # 固定当前标题
node "{{plugin_root}}/cli.mjs" unlock --config "{{ZCODE_PLUGIN_DATA}}/config.json"    # 解除固定
node "{{plugin_root}}/cli.mjs" policy --config "{{ZCODE_PLUGIN_DATA}}/config.json"    # 查询策略
```

规则：

- 暂停/恢复只改 `enabled`，保留模型选择等其余配置；读写复核后报告结果。
- 标题策略文件与 suian-zcode-title 插件共享（`~/.zcode/tools/suian-zcode-common/session-titles/<session>.json`），两个插件互认锁定，不会互相抢改名。
- lock 前先确认目标会话存在（CLI 自动校验）；解锁后下一轮 Stop 恢复自动命名。
- 本技能不提供"手动改成某标题"的能力：手动改标题请直接在 ZCode 界面操作，插件检测到非宿主改名会自动锁定不再覆盖；改完后如需恢复自动命名，用 unlock。
