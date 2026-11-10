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
      // 直连模式：返回本地静态目录供 validateSelection 校验
      return modelCatalog();
    },
    async generate(context,selection) {
      if(!selection)throw new Error("缺少模型选择");
      // 家族推断 → 目录校验 → 直调。
      // passthrough（host-follow 命中由 resolveSelection 显式标记）表示模型名是主对话透传的裸名，
      // 直调端点接受任意模型名，故只校验家族覆盖；fixed 与 host-follow 回落走目录内精确匹配。
      // 来源不再靠 providerId 是否恰好等于家族名来猜。
      const catalog=modelCatalog();
      // providerId 只用于家族推断（如 magpie→bigmodel），目录校验按家族名进行
      const {resolveFamily}=await import("./modelcall.mjs");
      let family;
      try {family=resolveFamily(selection.providerId,selection.modelId);}catch(error){throw new Error(error.message);}
      const selectionError=selection.passthrough
        ?(catalog.providers.some(p=>p.providerId===family)?null:`模型家族 ${family} 不在直连目录中`)
        :validateSelection({...selection,providerId:family},catalog);
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
