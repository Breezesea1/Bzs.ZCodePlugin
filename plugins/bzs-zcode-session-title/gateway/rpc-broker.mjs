import { randomUUID } from 'node:crypto';
import { win32 } from 'node:path';
import { Hs as encode, Bs as Assembler, Ws as parse, S as workspaceKey } from '../vendor/remote-shared.js';
import { BufferReader, BufferWriter, deserialize, serialize } from '../vendor/serialization.js';
import { VSBuffer } from '../vendor/buffer.js';
import { ChannelClient } from '../vendor/channelClient.js';
import { Emitter } from '../vendor/foundation.js';
import { rpcDiagnostic, rpcPayloadDiagnostic } from './rpc-diagnostics.mjs';

const samePath = (a, b) => win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase();
const packet = (header, tail = Buffer.from([0])) => {
  const writer = new BufferWriter(); serialize(writer, header); writer.write(VSBuffer.wrap(tail)); return writer.buffer.buffer;
};
const headerOf = bytes => { const reader = new BufferReader(VSBuffer.wrap(bytes)); const header = deserialize(reader); return { header, tail: bytes.subarray(reader.pos) }; };

// Local workspace attachments all enter the same window Host in ZCode 3.14.4.
// The broker owns its one physical bridge; peers retain separate RPC ID spaces.
export function createRpcBroker({ bootstrap, sendDesktop, sendPhone, bridgeTimeoutMs = 5000, onError = () => {} }) {
  let physical, phone, nextId = 1;
  const peers = new Set(), localPeers = new Set(), routes = new Map(), bridgeRequests = new Set();
  const resetPhysical = error => {
    if (physical) {
      error.diagnostic = { bridgeReady: physical.readyReceived, bridgeInitialized: physical.initialized, ...error.diagnostic };
      clearTimeout(physical.timer); physical.ready.reject(error); physical.initialize.reject(error); physical = undefined;
    }
  };
  const hostSend = bytes => {
    const frames = encode(bytes, { ...physical.identity, firstPhysicalSeq: physical.seq, messageSeq: physical.message++ });
    physical.seq += frames.length;
    for (const frame of frames) sendDesktop(frame);
  };
  const forwardRequest = id => {
    const route = routes.get(id), { peer, localId, header } = route;
    let tail = route.tail;
    if (header[0] === 100 && header[2] === 'zcode-agent') {
        const method = header[3];
        if (method === 'helloConversationV4') route.onSuccess = () => { peer.helloIssued = true; };
        if (method === 'initializeConversationV4' || method === 'sendConversationCommandV4') {
          const args = route.initializeArgs ?? deserialize(new BufferReader(VSBuffer.wrap(tail))), params = args[0];
          let reason;
          if (method === 'initializeConversationV4') {
            if (!peer.helloIssued) reason = 'fault.connection.helloRequired';
            else if (peer.clientHello && peer.clientHello.clientId !== params.clientId) reason = 'fault.connection.clientChanged';
            // Host 只绑定一个身份；手机是 v4 增量订阅的消费者，本地写调用不能覆盖其能力声明。
            args[0] = { ...params, clientId: physical.clientId,
              capabilities: peer !== phone && phone?.clientHello ? { ...params.capabilities, ...phone.clientHello.capabilities } : params.capabilities };
            route.onSuccess = () => { peer.clientHello = params; };
          } else {
            if (!peer.clientHello) reason = 'fault.connection.handshakeRequired';
            else if (params.envelope.clientId !== peer.clientHello.clientId) reason = 'fault.command.clientMismatch';
            args[0] = { ...params, envelope: { ...params.envelope, clientId: physical.clientId } };
          }
          const writer = new BufferWriter();
          if (reason) {
            serialize(writer, [202, localId]); serialize(writer, { name: 'Error', message: reason });
            peer.send(writer.buffer.buffer);
            routes.delete(id); peer.ids.delete(localId);
            if (physical.initializing === id) physical.initializing = undefined;
            return;
          }
          serialize(writer, args); tail = writer.buffer.buffer;
        }
    }
    route.sent = true;
    hostSend(packet([header[0], id, ...header.slice(2)], tail));
  };
  // 逐个等待初始化 ACK，之后才读取各端已绑定身份和手机能力，避免并发换绑或覆盖声明。
  const drainInitializations = () => {
    while (physical && !physical.initializing && physical.initializations.length) {
      const id = physical.initializations.shift();
      if (!routes.has(id)) continue; // 排队期间断开或取消的调用已经移除。
      physical.initializing = id;
      forwardRequest(id);
    }
  };
  const cancelPeer = peer => {
    for (const [localId, id] of peer.ids) {
      const route = routes.get(id);
      if (physical?.initialized && route.sent) hostSend(packet([route.event ? 103 : 101, id]));
      routes.delete(id);
      peer.ids.delete(localId);
      if (physical?.initializing === id) physical.initializing = undefined;
    }
    peers.delete(peer);
    drainInitializations();
    // Desktop 在终端失配后会结束桥；无人使用时不能把旧身份留给下一次附着。
    if (!localPeers.size && !phone && !peers.size) resetPhysical(new Error('Host bridge has no remaining peers'));
  };
  const request = (peer, bytes) => {
    const { header, tail } = headerOf(bytes);
    if (!Array.isArray(header) || ![100, 101, 102, 103].includes(header[0]) || !Number.isInteger(header[1]) || header[1] < 0) throw new Error('Invalid RPC request header');
    const [type, localId] = header;
    if (type === 100 || type === 102) {
      if (peer.ids.has(localId)) throw new Error('Duplicate RPC request ID');
      const initialize = type === 100 && header[2] === 'zcode-agent' && header[3] === 'initializeConversationV4';
      let initializeArgs;
      if (initialize) {
        initializeArgs = deserialize(new BufferReader(VSBuffer.wrap(tail)));
        if (!Array.isArray(initializeArgs) || typeof initializeArgs[0]?.clientId !== 'string') throw new Error('Invalid v4 clientId');
      }
      const id = nextId++;
      routes.set(id, { peer, localId, header, tail, initializeArgs, event: type === 102, sent: false }); peer.ids.set(localId, id);
      if (initialize) {
        physical.initializations.push(id); drainInitializations();
      } else forwardRequest(id);
    } else {
      const id = peer.ids.get(localId);
      if (id === undefined) return;
      if (routes.get(id).sent) hostSend(packet([type, id], tail));
      routes.delete(id); peer.ids.delete(localId);
      if (physical.initializing === id) physical.initializing = undefined;
      drainInitializations();
    }
  };
  // navigation 透传宿主两种建桥意图：{ project }（项目/草稿导航）或 { taskId, taskHostId }（按任务归属解析目录）。
  const ensureHost = async (workspacePath, navigation) => {
    if (!physical) {
      const identity = { bridgeSessionId: randomUUID(), bridgeGeneration: 1 };
      const ready = Promise.withResolvers(), initialize = Promise.withResolvers();
      physical = { identity, clientId: randomUUID(), initializations: [], requestId: randomUUID(), assembler: new Assembler({ identity }), seq: 1, message: 1, ready, initialize, readyReceived: false, initialized: false };
      physical.timer = setTimeout(() => resetPhysical(Object.assign(new Error('原 Host 桥初始化超时'), { code: 'gateway_bridge_timeout' })), bridgeTimeoutMs);
      bridgeRequests.add(physical.requestId);
      sendDesktop({ zcode_type: 'workspace-bridge-open', requestId: physical.requestId, ...identity, workspaceKey: workspacePath,
        ...(navigation?.project ? { project: navigation.project } : {}),
        ...(navigation?.taskId != null ? { taskId: navigation.taskId, ...(navigation.taskHostId != null ? { taskHostId: navigation.taskHostId } : {}) } : {}) });
    }
    const [meta] = await Promise.all([physical.ready.promise, physical.initialize.promise]);
    return meta;
  };
  const callHost = async (channel, method, args, timeoutMessage) => {
    const emitter = new Emitter(), fault = Promise.withResolvers();
    const peer = { ids: new Map(), send: bytes => emitter.fire(VSBuffer.wrap(bytes)), fail: error => fault.reject(error) };
    peers.add(peer);
    const client = new ChannelClient({ onMessage: emitter.event, send: bytes => request(peer, bytes.buffer), drain: () => Promise.resolve() });
    emitter.fire(VSBuffer.wrap(packet([200])));
    const timer = setTimeout(() => fault.reject(new Error(timeoutMessage)), bridgeTimeoutMs);
    try {
      return await Promise.race([client.getChannel(channel).call(method, args), fault.promise]);
    } finally { clearTimeout(timer); cancelPeer(peer); client.dispose(); emitter.dispose(); }
  };
  const attach = async (peer, { workspacePath, sessionId, projectId, suppliedBootstrap }) => {
    if (phone?.passthrough) throw Object.assign(new Error('手机当前使用远端工作区，本地 RPC 暂时让位'), { code: 'remote_workspace_busy' });
    peer.phase = 'bootstrap';
    const result = suppliedBootstrap ?? await bootstrap();
    if (!result.success) throw new Error('Desktop bootstrap failed');
    const workspace = result.result.workspaces.find(w => w.kind === 'local' && samePath(w.workspacePath, workspacePath));
    // 目录模式仍以窗口列表为准；未上报的项目或会话交原 Host 按身份解析。
    const project = !workspace && projectId !== undefined ? { projectId, hostId: 'local' } : undefined;
    if (!workspace && !project && sessionId === undefined) throw new Error('Requested local workspace is not open in the Desktop window');
    let anchorPath = workspace ? workspace.workspacePath : workspacePath;
    if (workspace && sessionId !== undefined && result.result.tasks !== undefined && !result.result.tasks.some(t => t.taskId === sessionId && samePath(t.workspacePath, anchorPath))) throw new Error('Session is not present in the requested workspace');
    peer.phase = 'bridge_initialize';
    const reused = Boolean(physical);
    const meta = await ensureHost(anchorPath, workspace ? undefined : project ? { project } : { taskId: sessionId, taskHostId: 'local' });
    if (project) {
      peer.phase = 'project_lookup';
      // 复用桥时只解析项目目录，不替换当前手机或插件的桥。
      const target = reused ? await callHost('project', 'prepareSession', [project], 'Host project navigation timed out') : meta;
      if ((!reused && meta.kind !== 'local') || typeof target.workspacePath !== 'string' || !samePath(target.workspacePath, workspacePath))
        throw new Error('project_workspace_mismatch: 原 Host 返回的项目主目录与本机索引不一致，未创建会话；请用 list_projects 核对');
      anchorPath = target.workspacePath;
    }
    // 3.16 bootstrap 不再返回 tasks；由目标工作区 Host 查询会话归属。
    if (sessionId !== undefined && (result.result.tasks === undefined || !workspace)) {
      peer.phase = 'session_lookup';
      const task = await callHost('zcode-task', 'getTaskMeta', [{ taskId: sessionId, workspacePath: anchorPath }], 'Host session lookup timed out');
      if (!task || task.taskId !== sessionId || !samePath(task.workspacePath, anchorPath)) throw new Error('Session is not present in the requested workspace');
    }
    peers.add(peer);
    return { bootstrap: result.result, workspace_path: anchorPath, meta };
  };
  return {
    async phoneOpen(payload) {
      if (phone) cancelPeer(phone);
      const identity = { bridgeSessionId: payload.bridgeSessionId, bridgeGeneration: payload.bridgeGeneration, ...(payload.recoveryId ? { recoveryId: payload.recoveryId } : {}) };
      const peer = { ids: new Map(), identity, assembler: new Assembler({ identity }), seq: 1, message: 1,
        fail: error => sendPhone({ zcode_type: 'bridge-degraded', ...identity, reason: error.code ?? 'gateway_rpc_failed', error: error.message }),
        send: bytes => {
          const frames = encode(bytes, { ...identity, firstPhysicalSeq: peer.seq, messageSeq: peer.message++ });
          peer.seq += frames.length;
          for (const frame of frames) sendPhone(frame);
        }
      };
      phone = peer;
      try {
        const result = await bootstrap();
        if (phone !== peer) return;
        if (!result.success) throw new Error('Desktop bootstrap failed');
        const workspace = result.result.workspaces.find(w => workspaceKey(w) === payload.workspaceKey);
        // 无项目会话的归属目录可能未在窗口登记；手机带 local 任务身份时交宿主按任务导航建桥。
        const taskIntent = !workspace && !payload.project && payload.taskId != null && payload.taskHostId === 'local'
          ? { taskId: payload.taskId, taskHostId: 'local' } : undefined;
        if (!workspace && !payload.project && !taskIntent) throw new Error('Requested workspace is not open in the Desktop window');
        const remote = payload.project ? (payload.project.hostId ?? 'local') !== 'local' : workspace ? workspace.kind !== 'local' : false;
        if (remote) {
          if (localPeers.size) throw Object.assign(new Error('本地 RPC 正在使用窗口 Host，暂不能切换远端工作区'), { code: 'remote_workspace_busy' });
          resetPhysical(new Error('Phone switched to a remote workspace'));
          peer.passthrough = true;
          sendDesktop(payload);
          return;
        }
        let attached;
        if (payload.project) {
          if (payload.taskId) throw new Error('Project navigation is unavailable.');
          const reused = Boolean(physical);
          // 新桥交给 Desktop 导航；已有桥通过同一 Host 解析项目目录，保留插件连接。
          const meta = await ensureHost(workspace?.workspacePath ?? payload.workspaceKey, { project: payload.project });
          if (phone !== peer) return;
          let targetPath = meta.workspacePath;
          if (reused) {
            const input = { ...payload.project };
            if (input.projectId === null) delete input.projectId;
            const directories = await callHost('project', 'prepareSession', [input], 'Host project navigation timed out');
            targetPath = directories.workspacePath;
          }
          attached = { meta, workspace_path: targetPath };
          peers.add(peer);
        } else if (taskIntent) {
          const reused = Boolean(physical);
          // 新桥透传任务意图由宿主导航解析归属目录；桥复用时不重开桥，服务调用按参数路由，
          // 任务归属经 Host getTaskMeta 复核后才对手机放行。
          const meta = await ensureHost(payload.workspaceKey, taskIntent);
          if (phone !== peer) return;
          let targetPath = meta.workspacePath;
          if (reused) {
            const task = await callHost('zcode-task', 'getTaskMeta', [{ taskId: payload.taskId, workspacePath: payload.workspaceKey }], 'Host session lookup timed out');
            if (!task || task.taskId !== payload.taskId || !samePath(task.workspacePath, payload.workspaceKey)) throw new Error('Session is not present in the requested workspace');
            targetPath = payload.workspaceKey;
          }
          attached = { meta, workspace_path: targetPath };
          peers.add(peer);
        } else attached = await attach(peer, { workspacePath: workspace.workspacePath, suppliedBootstrap: result });
        if (phone !== peer) { cancelPeer(peer); return; }
        sendPhone({ zcode_type: 'workspace-bridge-ready', requestId: payload.requestId, ...identity,
          bridge: { ...attached.meta, ...identity, workspaceKey: attached.workspace_path, workspacePath: attached.workspace_path, initialTaskId: payload.taskId } });
        peer.send(packet([200]));
      } catch (error) {
        const current = phone === peer;
        if (current) phone = undefined;
        cancelPeer(peer);
        if (current) sendPhone({ zcode_type: 'workspace-bridge-error', requestId: payload.requestId, ...identity, reason: 'gateway_attach_failed', error: error.message });
      }
    },
    phoneFrame(payload) {
      if (!phone) return;
      if (phone.passthrough) { sendDesktop(payload); return; }
      if (payload.bridgeSessionId !== phone.identity.bridgeSessionId || payload.bridgeGeneration !== phone.identity.bridgeGeneration || payload.recoveryId !== phone.identity.recoveryId) return;
      try {
        const frame = parse(payload);
        if (frame?.zcode_type === 'rpc-frame-ack') return;
        if (!frame) throw new Error('Invalid phone RPC frame');
        const result = phone.assembler.accept(frame);
        if (result.kind === 'fault') throw new Error(result.fault.reasonCode);
        if (result.kind === 'complete') request(phone, Buffer.from(result.bytes));
        const ack = result.kind === 'complete' ? result.messageSeq : result.kind === 'duplicate' ? result.ackMessageSeq : null;
        if (ack) sendPhone({ zcode_type: 'rpc-frame-ack', ...phone.identity, ackMessageSeq: ack });
      } catch (error) { const failed = phone; phone = undefined; cancelPeer(failed); failed.fail(error); }
    },
    desktopPayload(payload) {
      if (payload.zcode_type === 'workspace-bridge-ready' && physical?.requestId === payload.requestId) { physical.readyReceived = true; physical.ready.resolve(payload.bridge); return true; }
      if (payload.zcode_type === 'workspace-bridge-error' && physical?.requestId === payload.requestId) {
        resetPhysical(new Error(payload.error ?? payload.reason)); return true;
      }
      if (['workspace-bridge-ready', 'workspace-bridge-error'].includes(payload.zcode_type) && bridgeRequests.has(payload.requestId)) return true;
      if (!physical || payload.bridgeSessionId !== physical.identity.bridgeSessionId) {
        if (['rpc-frame', 'rpc-frame-ack', 'bridge-degraded'].includes(payload.zcode_type)) return !(phone?.passthrough && payload.bridgeSessionId === phone.identity.bridgeSessionId);
        return false;
      }
      if (payload.zcode_type === 'rpc-frame-ack') return true;
      if (payload.zcode_type === 'bridge-degraded') throw Object.assign(new Error('原 Host RPC 桥已降级'), {
        diagnostic: { causeCode: 'bridge_degraded', ...rpcPayloadDiagnostic(payload), bridgeInitialized: physical.initialized }
      });
      if (payload.zcode_type !== 'rpc-frame') return false;
      const result = physical.assembler.accept(parse(payload));
      if (result.kind === 'fault') throw Object.assign(new Error(result.fault.reasonCode), {
        diagnostic: { ...result.fault, causeCode: result.fault.reasonCode, ...rpcPayloadDiagnostic(payload), bridgeInitialized: physical.initialized }
      });
      if (result.kind === 'complete') {
        const bytes = Buffer.from(result.bytes), { header, tail } = headerOf(bytes);
        if (header[0] === 200) { physical.initialized = true; clearTimeout(physical.timer); physical.initialize.resolve(); }
        else {
          const route = routes.get(header[1]);
          if (route) {
            if (header[0] === 201) route.onSuccess?.();
            route.peer.send(packet([header[0], route.localId, ...header.slice(2)], tail));
            if (!route.event) {
              routes.delete(header[1]); route.peer.ids.delete(route.localId);
              if (physical.initializing === header[1]) physical.initializing = undefined;
              drainInitializations();
            }
          }
        }
      }
      const ack = result.kind === 'complete' ? result.messageSeq : result.kind === 'duplicate' ? result.ackMessageSeq : null;
      if (ack) sendDesktop({ zcode_type: 'rpc-frame-ack', ...physical.identity, ackMessageSeq: ack });
      return true;
    },
    acceptLocal(socket) {
      const peer = { ids: new Map(), send: bytes => socket.send(bytes), fail: error => {
        if (socket.readyState === 1) { socket.send(JSON.stringify({ type: 'error', code: error.code ?? 'gateway_rpc_failed', message: error.message, diagnostic: error.diagnostic })); socket.close(1011, 'RPC attachment failed'); }
      } };
      localPeers.add(peer);
      let stage = 'new';
      socket.on('message', async (data, binary) => {
        try {
          if (binary) { peer.phase = 'rpc_request'; if (stage !== 'attached') throw new Error('Attach a workspace before RPC'); request(peer, data); }
          else {
            if (stage !== 'new') throw new Error('Workspace already attached');
            const message = JSON.parse(data.toString());
            if (message.type !== 'attach' || typeof message.workspace_path !== 'string') throw new Error('Invalid workspace attachment');
            if (message.project_id !== undefined && (typeof message.project_id !== 'string' || !message.project_id.trim() || message.session_id !== undefined))
              throw new Error('Invalid project attachment');
            stage = 'attaching';
            const result = await attach(peer, { workspacePath: message.workspace_path, sessionId: message.session_id, projectId: message.project_id });
            if (socket.readyState !== 1) { cancelPeer(peer); return; }
            stage = 'attached';
            socket.send(JSON.stringify({ type: 'attached', bootstrap: result.bootstrap, workspace_path: result.workspace_path }));
            peer.send(packet([200]));
          }
        } catch (error) {
          error.diagnostic = rpcDiagnostic(error, { phase: peer.phase ?? 'rpc_attach' });
          onError(error);
          peer.fail(error);
        }
      });
      socket.on('close', () => { localPeers.delete(peer); cancelPeer(peer); });
    },
    phoneDisconnected() { if (phone) { const ended = phone; phone = undefined; cancelPeer(ended); } },
    // 忙判定 = 请求在飞（call/取消/排队 initialize）+ 未完成的共享桥初始化 + 手机远端透传盲区；
    // 订阅型路由与纯连接不计。透传期间网关看不到请求/应答边界，保守按忙，手机断开或切回本地工作区后解除；
    // 桥初始化有 bridgeTimeoutMs 上界，超时或失败即释放。
    inFlight() {
      let count = 0;
      for (const route of routes.values()) if (!route.event) count++;
      if (physical && !physical.initialized) count++;
      if (phone?.passthrough) count++;
      return count;
    },
    close(error) {
      resetPhysical(error);
      const affected = new Set([...peers, ...localPeers, ...(phone ? [phone] : [])]);
      for (const peer of affected) peer.ids.clear();
      peers.clear(); localPeers.clear(); routes.clear(); phone = undefined;
      for (const peer of affected) peer.fail(error);
    }
  };
}
