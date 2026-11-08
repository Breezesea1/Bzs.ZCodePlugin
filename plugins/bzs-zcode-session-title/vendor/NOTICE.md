# 协议与投影库来源

- projection.js：来自 zai-org/ZCode commit `29628c9acdb81b703bbd4080c207a0e7ce5e276e` 的 packages/shared/src/conversation-message-projection-policy.ts，经 Node.js stripTypeScriptTypes(mode:transform) 编译。
- 原源码未改，Apache-2.0 许可证见 LICENSE-ZCode；完整上游 NOTICE 保留在 NOTICE-ZCode-current.md。
- title-policy.mjs 是本插件自有模块（标题锁定策略文件），无外部来源。

适配实现均位于 vendor 之外。0.3.0 起插件去网关化直连 Desktop 数据层，RPC 协议库（foundation/buffer/serialization/channels.shared/channelClient/remote-shared/ws）已随 gateway/ 一并移除。
