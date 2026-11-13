---
name: configuration
description: 配置 ZCode 自动总结命名的模型、思考档位、标题格式与轮数窗口，保留既有选择和暂停状态。
---

# 模型与命名配置

配置文件在插件数据目录 `${ZCODE_PLUGIN_DATA}/config.json`。先读当前内容，所有修改保留既有字段与 `enabled` 开关；写回用临时文件 + 原子重命名。改完跑一次 doctor 验证。

## 字段

```jsonc
{
  // 模型选择：可配置宿主 ZCode 中已启用的任意渠道、模型与可用思考档位
  "selection": {
    "providerId": "magpie",
    "modelId": "bzs/auto/glm-5.3-flash",
    "options": { "reasoningLevel": "low" }  // 按目标模型在宿主目录中实际支持的档位填写
  },
  "enabled": true,            // 总开关；false 时 Stop hook 静默跳过
  "timeoutMs": 120000,        // 1000–300000，单次模型调用超时
  "maxOutputTokens": 2048,    // 256–16384，总结输出上限
  "rename": {
    "requireFormat": true,    // 标题必须符合「emoji 对象｜目标」结构
    "maxTitleChars": 48,      // 10–96，标题 Unicode 字符上限
    "minTitleChars": 6,       // 3–maxTitleChars-1
    "maxTurns": 6             // 1–20，送入模型的最近对话轮数
  }
}
```

`selection.providerId` / `modelId` / `reasoningLevel` 直接对齐宿主 ZCode 的真实模型目录（包含官方账号渠道、模板派生渠道及所有自定义渠道，支持 `anthropic-messages` / `openai-responses` / `openai-chat-completions` 全部三种协议）：
修改模型前先运行 `node "{{plugin_root}}/cli.mjs" models`（stdin `{}`）读取宿主当前可用渠道、模型 ID 与支持档位，核对存在后再写入配置。

## 查询与排障

- `status`（stdin `{}`）：查看生效配置、数据目录与命名参数。
- `models`（stdin `{}`）：直接读取宿主 ZCode 当前可用模型目录与各模型的支持档位，无需会话上下文或已有配置文件。
- `usage.jsonl` / `runner.log.jsonl` / `hook.log.jsonl` 在数据目录下，按时间倒序看最近几行定位失败原因。
- 思考档位越高总结越准但越慢；长会话建议 `maxTurns` 6–8、低思考档位（如 `low` / `disabled`）。
- 标题字符上限 `maxTitleChars` 会同步渲染进总结 prompt（`{{max_title_chars}}` 占位符）。

修改 selection 后必须跑 doctor（stdin 传当前会话）确认 `model_catalog` 与 `credentials` 通过，再决定是否 enable。
