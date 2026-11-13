---
name: debug
description: 排查 ZCode 自动总结命名不触发、标题异常、模型错误与直连链路故障，区分配置就绪与真实执行。
---

# 排障

现象先行：确认"没触发"还是"触发了但失败"。三个日志都在数据目录 `${ZCODE_PLUGIN_DATA}/state/`（或配置的 dataDir）：

- `hook.log.jsonl` — Stop hook 是否被宿主调用、派发动作（dispatched/disabled/not_configured/error）。
- `runner.log.jsonl` — worker 每次执行的命令、状态、reasonCode 与耗时。
- `usage.jsonl` — 每次命名的 action/title/reason 与结果状态。

## 常见故障

1. **hook.log 里没有新行** → 插件未启用或 Hook 未加载。检查 Settings → Plugins 中本插件是否启用；`config.json` 的 `enabled` 是否为 false。
2. **hook 显示 dispatched 但 runner.log 无对应行** → worker 启动失败。手动重跑：stdin 传会话事件执行 `node "{{plugin_root}}/cli.mjs" run --apply --config ...`，看输出 JSON 的 error/reasonCode。
3. **指定渠道/模型不在宿主可用模型目录中 / 指定思考档位不可用** → `selection` 与宿主当前启用配置不符（例如在 ZCode 设置里关闭了该渠道/模型或改了模型 ID）。运行 `node "{{plugin_root}}/cli.mjs" models` 核对宿主当前可用模型与档位，按 [configuration](../configuration/SKILL.md) 更新 `selection`。
4. **reasonCode=credentials_missing / credentials_decrypt_failed** → 所选官方账号渠道（`account:bigmodel-*` / `account:zai-*`）登录凭据缺失或失效。确认 Desktop 已登录对应账号，或改配其他 API Key 渠道模型。
5. **reasonCode=model_project_unavailable / model_token_mint_failed** → 官方账号下没有可用机构/项目或短时 token 铸造被拒。到对应开放平台确认项目状态。
6. **reasonCode=model_http_error / model_request_failed / model_error** → 模型端点报错或超时。查看错误中的 HTTP 状态或上游业务消息（如代理服务未启动、上游关闭了某模型、余额或并发受限）。
7. **状态 locked / manual_title** → 用户手动改过标题或策略文件锁定，属预期保护；需要恢复自动命名时用 [control](../control/SKILL.md) 的 unlock。
8. **stale_result** → 命名执行期间会话又变化（正常竞态），下一轮 Stop 会自动重试；连续出现才需要排查。
9. **reasonCode=index_db_missing / 改名未生效** → 任务索引不可达或行缺失。确认 `~/.zcode/v2/tasks-index.sqlite` 存在；会话需在 Desktop 有任务记录。
10. **改名成功但列表标题未变** → 已打开的任务列表依赖宿主下次刷新（窗口聚焦/列表重开）；数据层已一致，非故障。
11. **标题一直不变（unchanged）** → 指纹未变化，属预期；若会话内容明显变化仍 unchanged，先删除数据目录中该会话的状态文件 `<session_id>.json` 再观察一轮。

## 快速体检

stdin 传 `{"session_id":"...","workspace_path":"..."}`：

```bash
node "{{plugin_root}}/cli.mjs" models
node "{{plugin_root}}/cli.mjs" doctor --config "{{ZCODE_PLUGIN_DATA}}/config.json"
node "{{plugin_root}}/cli.mjs" probe  --config "{{ZCODE_PLUGIN_DATA}}/config.json"
```

`models` 列出宿主当前全部可用渠道、模型与档位；`doctor` 输出 selection / history / task_index / model_catalog / credentials 五项检查；`probe` 测所选渠道鉴权与任务索引可达。修完后用 `run --apply`（不传 `--apply` 则只预览不改名）验证完整链路，再把最终结论报告给用户。
