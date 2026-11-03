// 原宿主通道适配层：写操作（改名）与模型调用统一经公共网关 RPC，
// 会话数据读取统一走 history.mjs 持久层；本模块不含业务状态机。
import {connectHost} from "./gateway/connect.mjs";
import {readHistory,conversationSnapshot,sessionExistsInSessionDb,loadIndexRow,SESSION_ID_RE} from "./history.mjs";
import {validateSelection} from "./config.mjs";
import {readTitlePolicy} from "./vendor/title-policy.mjs";

const sleep=ms=>new Promise(r=>setTimeout(r,ms));

export function createBackend({event,config,saveState,prompt,connect=connectHost,retryDelaysMs=[10000,30000]}) {
  const sessionId=event.session_id;
  if(!SESSION_ID_RE.test(sessionId??""))throw new Error("输入需要有效 session_id");
  let remote;
  // 会话归属工作区以库中记录为权威；索引行次选，事件 payload 最后兜底
  let resolvedWorkspace=null;
  const loadIndexRowForSession=()=>loadIndexRow({dbPath:config.indexDb,sessionId,sqliteBin:config.sqliteBin});
  const resolveWorkspace=async()=>{
    if(resolvedWorkspace)return resolvedWorkspace;
    try {
      const history=await readHistory({dbPath:config.sessionDb,sqliteBin:config.sqliteBin,sessionId});
      if(history.session.directory){resolvedWorkspace=history.session.directory;return resolvedWorkspace;}
    }catch {}
    const row=await loadIndexRowForSession();
    if(row?.workspace_path){resolvedWorkspace=row.workspace_path;return resolvedWorkspace;}
    const fallback=event.workspace_path??event.cwd;
    if(!fallback)throw new Error("任务索引与 CLI 库中都没有目标会话，且事件未携带工作区");
    resolvedWorkspace=fallback;
    return resolvedWorkspace;
  };
  const attach=async()=>{
    if(!remote) {
      remote=await connect({
        workspacePath:await resolveWorkspace(),sessionId,
        gatewayConfigPath:config.gatewayConfigPath,
        timeoutMs:config.timeoutMs,
        handshakeTimeoutMs:Math.min(config.timeoutMs,8000)
      });
    }
    return remote;
  };
  // 网关忙时首个大调用可能被瞬断（gateway_rpc_protocol_error）：fault 已 reject 的
  // 连接无法复用，必须断开重连；按退避间隔重试，每个延迟只用一次。
  const call=async(channel,method,args=[])=>{
    const delays=[...retryDelaysMs];
    for(;;) {
      try {return await (await attach()).call(channel,method,args);}
      catch(error) {
        if(error.reasonCode!=="gateway_rpc_protocol_error"||!delays.length)throw error;
        remote?.close();remote=null;
        await sleep(delays.shift());
      }
    }
  };
  return {
    async read() {
      const ws=await resolveWorkspace();
      const row=await loadIndexRowForSession();
      // 新会话首轮索引行可能尚未写入：session.directory 已足以定位，不因缺行失败
      const history=await readHistory({dbPath:config.sessionDb,sqliteBin:config.sqliteBin,sessionId,workspacePath:ws});
      const snapshot=conversationSnapshot(history);
      if(remote) {
        // 已附着时校验宿主任务元与持久化标题一致，防漂移改名
        const meta=await call("zcode-task","getTaskMeta",[{taskId:sessionId,workspacePath:ws}]);
        if(meta.taskId!==sessionId||meta.workspacePath!==ws||meta.title!==history.session.title) {
          const mismatch=new Error("原宿主与持久化标题不一致");mismatch.reasonCode="host_title_mismatch";throw mismatch;
        }
      }
      return {
        ...snapshot,
        turnCount:snapshot.turns.length,
        title:history.session.title,
        titleSource:history.session.titleSource??null,
        titlePolicy:await readTitlePolicy({sessionId,directory:config.titlePolicyDirectory}),
        archived:!!row?.archived,deleted:!!row?.deleted,running:row?.task_status==="running"
      };
    },
    async sessionExists() {
      // 存在性校验：查询异常不吞，避免把"查不了"静默当"不存在"
      if(await sessionExistsInSessionDb({dbPath:config.sessionDb,sessionId,sqliteBin:config.sqliteBin}))return true;
      return (await loadIndexRowForSession())!==null;
    },
    async models() {return call("model-selection","getView",[]);},
    async generate(context,selection) {
      const view=await call("model-selection","getView",[]);
      const selectionError=validateSelection(selection,view);
      if(selectionError)throw new Error(selectionError);
      return call("zcode-agent","generateWorkspaceText",[{
        workspacePath:await resolveWorkspace(),selection,
        messages:[{role:"system",content:prompt},{role:"user",content:JSON.stringify(context)}],
        tools:[],querySource:"session_title_external",
        maxOutputTokens:config.maxOutputTokens,
        requestTimeoutMs:config.timeoutMs+10000
      }]);
    },
    async rename(title) {
      const ws=await resolveWorkspace();
      const result=await call("zcode-task","renameTask",[{taskId:sessionId,workspacePath:ws,title}]);
      if(result.taskId&&result.taskId!==sessionId)throw new Error("改名返回了不同会话");
      if(result.title!==title)throw new Error("原宿主改名响应不一致");
    },
    saveState,
    close() {remote?.close();}
  };
}
