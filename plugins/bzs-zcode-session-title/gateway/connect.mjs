// 公共网关 RPC 客户端（自包含）。协议与 suian-zcode-common 网关一致：
// 1) GET /health 校验网关与 Desktop 就绪；2) WS /rpc 用 control_token 握手，
// attach 后经 RPC 帧多路复用调用 zcode-task / zcode-agent / model-selection。
// WebSocket 使用 vendored ws 8.22.0（MIT，见 vendor/ 目录），不依赖 npm 安装。
import {readFile} from "node:fs/promises";
import {homedir} from "node:os";
import {join} from "node:path";
import WebSocket from "../vendor/ws/index.js";
import {ChannelClient} from "../vendor/channelClient.js";
import {Emitter} from "../vendor/foundation.js";
import {VSBuffer} from "../vendor/buffer.js";

const failure=(reasonCode,message,stage="gateway")=>Object.assign(new Error(message),{stage,reasonCode});
const defaultConfig=join(homedir(),".zcode","tools","suian-zcode-gateway","config.json");

export async function connectHost({workspacePath,sessionId,gatewayConfigPath=defaultConfig,timeoutMs=120000,handshakeTimeoutMs=8000}) {  let config;
  try {config=JSON.parse(await readFile(gatewayConfigPath,"utf8"));}
  catch(error) {
    if(error.code==="ENOENT")throw failure("gateway_not_configured","公共网关尚未配置，请按公共 skill 安装","config");
    if(error instanceof SyntaxError)throw failure("gateway_invalid_config","公共网关配置 JSON 无效","config");
    throw error;
  }
  if(config.version!==1||!Number.isInteger(config.port)||config.port<1||config.port>65535||typeof config.control_token!=="string"||!config.control_token)
    throw failure("gateway_invalid_config","公共网关配置无效","config");
  const healthUrl=`http://127.0.0.1:${config.port}/health`;
  let health;
  try {health=await (await fetch(healthUrl,{signal:AbortSignal.timeout(handshakeTimeoutMs)})).json();}
  catch(error) {throw failure("gateway_unreachable","公共网关健康检查失败："+error.name);}
  if(health.service!=="suian-zcode-gateway"||health.rpc_protocol_version!==1)throw failure("gateway_upgrade_required","运行中的网关未提供 RPC，请按公共 skill 重载网关后重试");
  const mode=health.mode===undefined?"relay":health.mode;
  if(!["relay","local-only","terminal"].includes(mode))throw failure("gateway_rpc_protocol_error","公共网关返回未知运行模式");
  if(!health.desktop_connected||(mode==="local-only"?!health.desktop_ready:!health.upstream_connected))
    throw failure("gateway_desktop_offline","Desktop 尚未就绪，或 relay 模式的官方上游尚未连接");
  const ready=Promise.withResolvers(),fault=Promise.withResolvers(),emitter=new Emitter();
  const socket=new WebSocket(`ws://127.0.0.1:${config.port}/rpc`,{headers:{Authorization:`Bearer ${config.control_token}`},handshakeTimeout:handshakeTimeoutMs});
  const client=new ChannelClient({onMessage:emitter.event,send:bytes=>socket.send(bytes.buffer),drain:()=>Promise.resolve()});
  let attached,closing=false;
  let timer=setTimeout(()=>fault.reject(failure("gateway_timeout","公共网关附着超时")),handshakeTimeoutMs);
  socket.on("open",()=>socket.send(JSON.stringify({type:"attach",workspace_path:workspacePath,...(sessionId===undefined?{}:{session_id:sessionId})})));
  socket.on("message",(data,binary)=>{
    try {
      if(binary) {emitter.fire(VSBuffer.wrap(data));return;}
      const message=JSON.parse(data.toString());
      if(message.type==="attached") {attached=message;ready.resolve();}
      else if(message.type==="error")fault.reject(failure(message.code,message.message));
    } catch(error) {
      fault.reject(Object.assign(failure("gateway_rpc_protocol_error","公共网关 RPC 消息无效，已提交操作结果可能未知"),{cause:error}));
      close();
    }
  });
  socket.on("error",()=>fault.reject(failure("gateway_connection_failed","公共网关 RPC 连接失败")));
  socket.on("close",()=>{if(!closing)fault.reject(failure("gateway_connection_closed","公共网关 RPC 连接已断开，已提交的操作结果可能未知"));});
  const close=()=>{closing=true;clearTimeout(timer);socket.close();client.dispose();emitter.dispose();};
  try {
    await Promise.race([Promise.all([ready.promise,client.whenInitialized()]),fault.promise]);
    clearTimeout(timer);timer=setTimeout(()=>fault.reject(failure("gateway_timeout","原 Host RPC 执行超时，结果可能未知")),timeoutMs);
    return {
      bootstrap:attached.bootstrap,workspacePath:attached.workspace_path,
      call:(channel,method,args=[])=>Promise.race([client.getChannel(channel).call(method,args),fault.promise]),
      probe:async()=>{
        const current=await (await fetch(healthUrl,{signal:AbortSignal.timeout(handshakeTimeoutMs)})).json();
        return {ok:current.desktop_connected&&(mode==="local-only"?current.desktop_ready:current.upstream_connected),stage:"gateway",mode,paired:current.paired,upstreamPaired:current.upstream_paired,localClients:current.local_clients};
      },
      close
    };
  } catch(error) {close();throw error;}
}

export async function probeHost(options) {
  // attach 阶段同样会被网关忙瞬断：整链重试后再报 degraded
  try {
    const result=await callWithRetry(connectHost,options,async connection=>({...await connection.probe(),hostReachable:true,workspaceFound:true,sessionFound:true}),{retryDelaysMs:options.retryDelaysMs??[8000,20000]});
    return result;
  } catch(error) {
    return {ok:false,stage:error.stage??"gateway",reasonCode:error.reasonCode??"gateway_error",paired:false,message:error.message};
  }
}

// 网关忙时 attach 后首个大调用可能被瞬断（gateway_rpc_protocol_error）：
// fault 已 reject 的连接无法复用，必须断开重连。按退避间隔重试，每个延迟只用一次。
// 所有命令通道（models/生成/改名）共用，默认 10s/30s，实测该窗口重试即恢复。
export async function callWithRetry(connectHost,options,work,{retryDelaysMs=[10000,30000]}={}) {
  const delays=[...retryDelaysMs];
  for(;;) {
    let connection;
    try {
      connection=await connectHost(options);
      return await work(connection);
    } catch(error) {
      if(error.reasonCode!=="gateway_rpc_protocol_error"||!delays.length)throw error;
      await new Promise(r=>setTimeout(r,delays.shift()));
    } finally {connection?.close();}
  }
}
