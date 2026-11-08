---
name: configuration
description: 配置 ZCode 自动总结命名的模型、思考档位、标题格式与轮数窗口，保留既有选择和暂停状态。
---

# 模型与命名配置

配置文件在插件数据目录 `${ZCODE_PLUGIN_DATA}/config.json`。先读当前内容，所有修改保留既有字段与 `enabled` 开关；写回用临时文件 + 原子重命名。改完跑一次 doctor 验证。

## 字段

```jsonc
{
  // 模型选择（必填；providerId 需含 bigmodel/magpie/glm 或 zai，模型来自 models 命令目录）
  "selection": {
    "providerId": "magpie",
    "modelId": "GLM-5.3-Flash",
    "options": { "reasoningLevel": "low" }  // minimal/low/medium/high/xhigh 中的可用档位
  },
  "enabled": true,            // 总开关；false 时 Stop hook 静默跳过
  "timeoutMs": 120000,        // 1000–300000，单次模型调用超时
  "maxOutputTokens": 2048,    // 256–16384，总结输出上限
  "sqliteBin": "sqlite3",     // 或 SQLITE_BIN 环境变量；建议绝对路径
  "rename": {
    "requireFormat": true,    // 标题必须符合「emoji 对象｜目标」结构
    "maxTitleChars": 48,      // 10–96，标题 Unicode 字符上限
    "minTitleChars": 6,       // 3–maxTitleChars-1
    "maxTurns": 6             // 1–20，送入模型的最近对话轮数
  }
}
```

`selection.providerId` / `modelId` / `reasoningLevel` 必须来自真实目录，不接受凭空选择：修改模型前先运行 `node "{{plugin_root}}/cli.mjs" models --config "{{ZCODE_PLUGIN_DATA}}/config.json"`（stdin `{}`）核对模型与档位确实存在。直连模式下 providerId 只需推断家族（含 `bigmodel`/`magpie`/`glm` 走 bigmodel 端点，含 `zai` 走 z.ai 端点）。

## 查询与排障

- `status`（stdin `{}`）：查看生效配置、数据目录与最近一次命名结果。
- `models`（stdin `{}`）：查询模型目录，无需会话上下文。
- `usage.jsonl` / `runner.log.jsonl` / `hook.log.jsonl` 在数据目录下，按时间倒序看最近几行定位失败原因。
- 思考档位越高总结越准但越慢；长会话建议 `maxTurns` 6–8、`low` 或 `medium`。
- 标题字符上限 `maxTitleChars` 会同步渲染进总结 prompt（`{{max_title_chars}}` 占位符）。

修改 selection 后必须跑 doctor（stdin 传当前会话）确认 model_catalog 通过，再决定是否 enable。
