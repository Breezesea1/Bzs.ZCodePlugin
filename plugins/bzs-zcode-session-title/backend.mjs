// 直连适配层：会话数据读取走 history.mjs（SQLite 只读），改名直写任务索引（taskstore.mjs），
// 模型目录从宿主本地配置解析（hostcatalog.mjs），模型总结直调对应渠道端点（modelcall.mjs）。
import {readHistory,conversationSnapshot,sessionExistsInSessionDb,loadIndexRow,displayTitleOf,SESSION_ID_RE} from "./history.mjs";
import {validateSelection} from "./config.mjs";
import {readTitlePolicy} from "./vendor/title-policy.mjs";
import * as taskstore from "./taskstore.mjs";
import {loadHostCatalog} from "./hostcatalog.mjs";
import {generateText} from "./modelcall.mjs";
import {homedir} from "node:os";
import {join} from "node:path";

export function createBackend({event,config,saveState,prompt,generate=generateText,catalog=null,env=process.env}) {
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
  let catalogPromise=catalog?Promise.resolve(catalog):null;
  const getCatalog=()=>(catalogPromise??=loadHostCatalog({env}));
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
        // 插件只写 tasks-index 不改 session.title_source；session.titleSource==='custom' 或 handoff_pending bit2=1 必为用户手动改名
        manualOverride:history.session.titleSource==="custom"||((row?.handoffPending??0)&2)!==0,
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
      return getCatalog();
    },
    async generate(context,selection) {
      if(!selection)throw new Error("缺少模型选择");
      const view=await getCatalog();
      const selectionError=validateSelection(selection,view);
      if(selectionError)throw new Error(selectionError);
      const provider=view.providers.find(p=>p.providerId===selection.providerId);
      const model=provider.models.find(m=>m.modelId===selection.modelId);
      return generate({
        selection,
        provider,
        model,
        catalog:view,
        messages:[{role:"system",content:prompt},{role:"user",content:JSON.stringify(context)}],
        maxOutputTokens:config.maxOutputTokens,
        timeoutMs:config.timeoutMs,
        credentialsPath,
        env
      });
    },
    async rename(title,expectedTitle) {
      const ws=await resolveWorkspace();
      const updated=taskstore.renameTask({dbPath:config.indexDb,sessionId,workspacePath:ws,title,expectedTitle});
      if(!updated)throw new Error("任务索引中没有目标会话行或标题已被手动接管，改名未生效");
    },
    saveState,
    close() {taskstore.close();}
  };
}
