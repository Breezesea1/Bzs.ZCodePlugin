---
name: debug
description: 排查 ZCode 自动总结命名不触发、标题异常、模型错误与网关故障，区分配置就绪与真实执行。
---

# 排障

现象先行：确认"没触发"还是"触发了但失败"。三个日志都在数据目录 `${ZCODE_PLUGIN_DATA}/state/`（或配置的 dataDir）：

- `hook.log.jsonl` — Stop hook 是否被宿主调用、派发动作（dispatched/disabled/not_configured/error）。
- `runner.log.jsonl` — worker 每次执行的命令、状态、reasonCode 与耗时。
- `usage.jsonl` — 每次命名的 action/title/reason 与结果状态。

## 常见故障

1. **hook.log 里没有新行** → 插件未启用或 Hook 未加载。检查 Settings → Plugins 中本插件是否启用；`config.json` 的 `enabled` 是否为 false。
2. **hook 显示 dispatched 但 runner.log 无对应行** → worker 启动失败。手动重跑：stdin 传会话事件执行 `node "{{plugin_root}}/cli.mjs" run --apply --config ...`，看输出 JSON 的 error/reasonCode/stage。
3. **reasonCode=gateway_not_configured / gateway_unreachable / gateway_desktop_offline** → 网关问题。按公共 skill [suian-zcode-common:debug] 处理；确认桌面端移动端远控面板已开启（出现"已连接"或"等待连接"）。
4. **reasonCode=gateway_handshake_rejected** → control_token 与运行中网关不一致：网关重载后配置文件已更新，重试即可；持续出现则按公共 skill 重载网关。
5. **指定模型不在原 Host 的可用目录中 / 指定思考档位不可用** → selection 与实际目录不符。跑 `models` 命令核对后按 [configuration](../configuration/SKILL.md) 修正。
6. **状态 locked / manual_title** → 用户手动改过标题或策略文件锁定，属预期保护；需要恢复自动命名时用 [control](../control/SKILL.md) 的 unlock。
7. **stale_result** → 命名执行期间会话又变化（正常竞态），下一轮 Stop 会自动重试；连续出现才需要排查。
8. **reasonCode=gateway_rpc_protocol_error 已自动重试** → worker 内置 10s/30s 退避重连；若最终仍失败说明网关持续忙，按公共 skill [suian-zcode-common:debug] 处理。
9. **标题一直不变（unchanged）** → 指纹未变化，属预期；若会话内容明显变化仍 unchanged，先删除数据目录中该会话的状态文件 `<session_id>.json` 再观察一轮。

## 快速体检

stdin 传 `{"session_id":"...","workspace_path":"..."}`：

```bash
node "{{plugin_root}}/cli.mjs" doctor --config "{{ZCODE_PLUGIN_DATA}}/config.json"
node "{{plugin_root}}/cli.mjs" probe  --config "{{ZCODE_PLUGIN_DATA}}/config.json"
```

doctor 输出 history / gateway / model_catalog 三项检查；probe 只测网关链路。修完后用 `run --apply`（不传 --apply 则只预览不改名）验证完整链路，再把最终结论报告给用户。
