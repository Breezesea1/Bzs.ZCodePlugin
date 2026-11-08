// 直连适配层：会话数据读取走 history.mjs（SQLite 只读），改名直写任务索引（taskstore.mjs），
// 模型总结直调 Anthropic 兼容端点（modelcall.mjs）。本模块不含业务状态机。
import {readHistory,conversationSnapshot,sessionExistsInSessionDb,loadIndexRow,displayTitleOf,SESSION_ID_RE} from "./history.mjs";
import {validateSelection} from "./config.mjs";
import {readTitlePolicy} from "./vendor/title-policy.mjs";
import * as taskstore from "./taskstore.mjs";
import {generateText,modelCatalog} from "./modelcall.mjs";
import {homedir} from "node:os";
import {join} from "node:path";

export function createBackend({event,config,saveState,prompt,generate=generateText,env=process.env}) {
  const sessionId=event.session_id;
  if(!SESSION_ID_RE.test(sessionId??""))throw new Error("输入需要有效 session_id");
  // 会话归属工作区以库中记录为权威；索引行次选，事件 payload 最后兜底
  let resolvedWorkspace=null;
  const loadIndexRowForSession=()=>loadIndexRow({dbPath:config.indexDb,sessionId});
  const resolveWorkspace=async()=>{
    if(resolvedWorkspace)return resolvedWorkspace;
    try {
      const history=await readHistory({dbPath:config.sessionDb,sessionId});
      if(history.session.directory){resolvedWorkspace=history.session.directory;return resolvedWorkspace;}
    }catch {}
    const row=await loadIndexRowForSession();
    if(row?.workspace_path){resolvedWorkspace=row.workspace_path;return resolvedWorkspace;}
    const fallback=event.workspace_path??event.cwd;
    if(!fallback)throw new Error("任务索引与 CLI 库中都没有目标会话，且事件未携带工作区");
    resolvedWorkspace=fallback;
    return resolvedWorkspace;
  };
  const credentialsPath=env.BZS_TITLE_CREDENTIALS??join(homedir(),".zcode","v2","credentials.json");
  return {
    async read() {
      const ws=await resolveWorkspace();
      const row=await loadIndexRowForSession();
      // 新会话首轮索引行可能尚未写入：session.directory 已足以定位，不因缺行失败
      const history=await readHistory({dbPath:config.sessionDb,sessionId,workspacePath:ws});
      const snapshot=conversationSnapshot(history);
      return {
        ...snapshot,
        turnCount:snapshot.turns.length,
        // 标题按 UI 同款解析：cli_title 是外部写入位，宿主镜像 title 列有延迟窗口
        title:displayTitleOf(row)??history.session.title,
        titleSource:row?.cliTitleSource??history.session.titleSource??null,
        titlePolicy:await readTitlePolicy({sessionId,directory:config.titlePolicyDirectory}),
        archived:!!row?.archived,deleted:!!row?.deleted,running:row?.taskStatus==="running"
      };
    },
    async sessionExists() {
      // 存在性校验：查询异常不吞，避免把"查不了"静默当"不存在"
      if(await sessionExistsInSessionDb({dbPath:config.sessionDb,sessionId}))return true;
      return (await loadIndexRowForSession())!==null;
    },
    async models() {
      // 网关模式：模型目录来自宿主 model-selection.getView（跟随主对话可选模型）。
      // 探测失败静默回落静态直连目录——models 是无副作用的查询，失败不应阻断配置校验。
      if(config.gateway?.mode==="gateway"||config.gateway?.mode==="auto") {
        try {
          const {connectHost}=await import("./gateway/gateway-client.mjs");
          const ws=await resolveWorkspace();
          const connection=await connectHost({workspacePath:ws,sessionId,timeoutMs:8000,handshakeTimeoutMs:4000});
          try {return await connection.call("model-selection","getView",[]);}finally {connection.close();}
        }catch {}
      }
      // 直连模式：返回本地静态目录供 validateSelection 校验
      return modelCatalog();
    },
    async generate(context,selection) {
      // 网关模式：借宿主模型路由生成（selection 由命名层按宿主目录校验后透传），
      // 计费/凭据全由宿主管理；网关不可达时回落直连。
      if(config.gateway?.mode==="gateway"||config.gateway?.mode==="auto") {
        try {
          const {connectHost}=await import("./gateway/gateway-client.mjs");
          const ws=await resolveWorkspace();
          const connection=await connectHost({workspacePath:ws,sessionId,timeoutMs:config.timeoutMs,handshakeTimeoutMs:4000});
          try {
            const view=await connection.call("model-selection","getView",[]);
            const selectionError=validateSelection(selection,view);
            if(selectionError)throw new Error(selectionError);
            return await connection.call("zcode-agent","generateWorkspaceText",[{
              workspacePath:ws,selection,
              messages:[{role:"system",content:prompt},{role:"user",content:JSON.stringify(context)}],
              tools:[],querySource:"session_title_external",
              maxOutputTokens:config.maxOutputTokens,
              requestTimeoutMs:config.timeoutMs
            }]);
          }finally {connection.close();}
        }catch(error) {
          if(config.gateway?.mode==="gateway")throw error; // 强网关模式不回落
          // auto 模式：网关失败回落直连（网关未装/未启动是常态而非故障）
        }
      }
      // 直连模式：家族推断 → 静态目录校验 → 直调
      const catalog=modelCatalog();
      // providerId 只用于家族推断（如 magpie→bigmodel），目录校验按家族名进行
      const {resolveFamily}=await import("./modelcall.mjs");
      let family;
      try {family=resolveFamily(selection.providerId);}catch(error){throw new Error(error.message);}
      const selectionError=validateSelection({...selection,providerId:family},catalog);
      if(selectionError)throw new Error(selectionError);
      return generate({
        selection,
        messages:[{role:"system",content:prompt},{role:"user",content:JSON.stringify(context)}],
        maxOutputTokens:config.maxOutputTokens,
        timeoutMs:config.timeoutMs,
        credentialsPath,
        env
      });
    },
    async rename(title) {
      const ws=await resolveWorkspace();
      const updated=taskstore.renameTask({dbPath:config.indexDb,sessionId,workspacePath:ws,title});
      if(!updated)throw new Error("任务索引中没有目标会话行，改名未生效");
    },
    saveState,
    close() {taskstore.close();}
  };
}
