# 协议与投影库来源

- foundation.js、buffer.js、serialization.js、channels.shared.js、channelClient.js：来自 zai-org/ZCode commit `29628c9acdb81b703bbd4080c207a0e7ce5e276e` 的 packages/rpc/src，经 Node.js stripTypeScriptTypes(mode:transform) 编译。
- projection.js：同一 commit 的 packages/shared/src/conversation-message-projection-policy.ts，经相同编译。
- 原源码未改，Apache-2.0 许可证见 LICENSE-ZCode。
- remote-shared.js：2026-10-06 读取的官方公共远控共享产物 https://zcode.z.ai/remote/v4/latest/assets/src-wmk2orCZ.js，原样保存；SHA-256 为 `239ddb6707e80303e61c414bd82f6b2a1ef650c0a066149583463b02442039f9`。该产物含共享 schema、分帧编码器和组装器。
- 只使用此构建的 Hs/Bs/Ws/S 导出。latest 产物可能变化，不自动更新；更新前需重新核对来源与契约。
- conversation-wire.js：来自 zai-org/ZCode 固定 commit `aac4755666d09fdcd70272fcf063c077a639015f` 的公开 V4 topic 逻辑帧组装器、编码器、会话帧/历史页 schema 及必要依赖。源码未修改，经 esbuild 0.28.2 编译为 Node 24 ESM；逐源 blob 与构建产物 SHA-256 见 conversation-wire.sources.json。此固定源码不代表当前安装版本；运行契约另由公开接口验证。
- conversation-wire.js 的上游许可为 Apache-2.0（LICENSE-ZCode），完整上游 NOTICE 保留在 NOTICE-ZCode-current.md；构建含已锁定的 zod 4.6.5，其 MIT 许可保留在 LICENSE-zod。适配和评论业务位于 vendor 之外。

适配实现均位于 vendor 之外。消息投影库由两个插件直接引用本目录，协议库由公共远控模块使用；不复制到插件目录。

