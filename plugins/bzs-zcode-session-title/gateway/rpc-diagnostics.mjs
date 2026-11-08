import { randomUUID } from 'node:crypto';

const choices = {
  phase: ['desktop_payload', 'rpc_attach', 'rpc_request', 'bootstrap', 'bridge_initialize', 'session_lookup', 'project_lookup', 'rpc_message', 'socket', 'health', 'connect', 'rpc_timeout', 'attach_timeout'],
  clientPhase: ['health', 'connect', 'attach', 'channel_initialize', 'rpc'],
  mode: ['relay', 'local-only', 'terminal'],
  source: ['desktop', 'upstream', 'local_rpc'],
  reasonCode: ['gateway_error', 'gateway_rpc_protocol_error', 'gateway_rpc_failed', 'gateway_bridge_timeout', 'gateway_timeout', 'gateway_connection_failed', 'gateway_connection_closed', 'gateway_desktop_offline', 'gateway_unreachable',
    'gateway_upgrade_required', 'gateway_invalid_config', 'gateway_not_configured', 'remote_workspace_busy', 'desktop_unpaired', 'terminal_failed',
    'relay_timeout', 'relay_connection_failed', 'relay_connection_closed', 'terminal_kicked', 'relay_rejected', 'relay_identity_mismatch', 'relay_heartbeat_timeout'],
  payloadType: ['bootstrap-response', 'workspace-bridge-ready', 'workspace-bridge-error', 'rpc-frame', 'rpc-frame-ack', 'bridge-degraded', 'unknown'],
  bridgeReason: ['terminal-owner-ended', 'rpc-transport-fault', 'source-session-replaced'],
  causeName: ['Error', 'SyntaxError', 'TypeError', 'RangeError', 'AbortError', 'TimeoutError'],
  causeCode: ['bridge_degraded', 'invalid_rpc_header', 'invalid_json',
    ...['invalidPhysicalSeq', 'invalidMessageSeq', 'invalidPhysicalLimit', 'invalidMessageLimit', 'invalidFragmentLimit', 'invalidTimeout', 'assemblyTimeout', 'identityMismatch', 'invalidBase64', 'invalidMetadata', 'messageTooLarge', 'fragmentLimitExceeded', 'envelopeTooLarge', 'conflictingDuplicate', 'physicalSequenceExhausted', 'messageSequenceExhausted', 'physicalGap', 'messageGap', 'fragmentGap', 'metadataMismatch', 'checksumMismatch', 'lengthMismatch'].map(code => `remote.rpcFrame.${code}`),
    'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPROTO', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'],
};
const counters = ['seq', 'messageSeq', 'fragmentIndex', 'fragmentCount', 'messageBytes', 'expectedSeq', 'expectedMessageSeq', 'localClients', 'rpcInFlight', 'elapsedMs', 'closeCode', 'frameBytes'];

// 本地 RPC 对端也是外部输入：仅接受固定枚举与数值元数据，绝不复制 payload、消息或任意异常文本。
export function sanitizeRpcDiagnostic(value) {
  const result = {};
  if (!value || typeof value !== 'object') return result;
  for (const [key, allowed] of Object.entries(choices)) if (allowed.includes(value[key])) result[key] = value[key];
  for (const key of counters) if (Number.isSafeInteger(value[key]) && value[key] >= 0) result[key] = value[key];
  for (const key of ['bridgeInitialized', 'bridgeReady', 'terminal', 'frameBinary']) if (typeof value[key] === 'boolean') result[key] = value[key];
  if ([1, 2].includes(value.relayProtocolVersion)) result.relayProtocolVersion = value.relayProtocolVersion;
  for (const key of ['gatewayVersion', 'desktopVersion']) if (typeof value[key] === 'string' && /^\d{1,5}(\.\d{1,5}){1,3}$/.test(value[key])) result[key] = value[key];
  if (typeof value.gatewayBuildId === 'string' && /^[a-f0-9]{64}$/.test(value.gatewayBuildId)) result.gatewayBuildId = value.gatewayBuildId;
  if (typeof value.id === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.id)) result.id = value.id;
  if (typeof value.at === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.at) && Number.isFinite(Date.parse(value.at))) result.at = value.at;
  return result;
}

export function rpcDiagnostic(error, context = {}) {
  const details = sanitizeRpcDiagnostic({ causeName: error.cause?.name ?? error.name, causeCode: error.cause?.code ?? error.code,
    ...error.cause?.diagnostic, ...error.diagnostic, ...context,
    reasonCode: context.reasonCode ?? error.reasonCode ?? error.code ?? error.diagnostic?.reasonCode ?? 'gateway_error' });
  return { id: randomUUID(), at: new Date().toISOString(), ...details };
}

export function rpcPayloadDiagnostic(payload) {
  return sanitizeRpcDiagnostic({ payloadType: choices.payloadType.includes(payload?.zcode_type) ? payload.zcode_type : 'unknown',
    bridgeReason: payload?.reason, seq: payload?.seq, messageSeq: payload?.messageSeq,
    fragmentIndex: payload?.fragmentIndex, fragmentCount: payload?.fragmentCount, messageBytes: payload?.messageBytes });
}
