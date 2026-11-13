// 环境与链路自检：不改动任何状态，只汇报各环节是否就绪。
import {readHistory} from "./history.mjs";
import {indexReachable} from "./taskstore.mjs";
import {validateSelection} from "./config.mjs";
import {verifyProviderAuth} from "./modelcall.mjs";
import {homedir} from "node:os";
import {join} from "node:path";

export async function runDoctor({backend,event,config,env=process.env}) {
  const checks=[];
  const check=(name,ok,detail)=>checks.push({name,ok,detail:detail??null});
  // 1. 配置与模型选择
  check("selection",!!config.selection,
    config.selection
      ?`${config.selection.providerId} / ${config.selection.modelId} / ${config.selection.options?.reasoningLevel}`
      :"未配置 selection");
  // 2. 会话定位（SQLite）
  try {
    const history=await readHistory({dbPath:config.sessionDb,sessionId:event.session_id,workspacePath:event.workspace_path??event.cwd});
    const snapshot=await backend.read();
    check("history",true,`会话标题「${history.session.title}」，有效对话轮 ${snapshot.turns.length}，指纹 ${snapshot.fingerprint.slice(0,12)}…`);
  } catch(error) {
    check("history",false,error.message);
  }
  // 3. 任务索引（改名写入位）
  const indexOk=indexReachable(config.indexDb);
  check("task_index",indexOk,indexOk?"任务索引可读写（cli_title 写入位）":"任务索引不可达："+config.indexDb);
  // 4 & 5. 宿主模型目录与所选渠道鉴权
  try {
    const view=await backend.models();
    const selectionError=validateSelection(config.selection,view);
    const provider=(view.providers??[]).find(p=>p.providerId===config.selection?.providerId);
    const model=provider?.models?.find(m=>m.modelId===config.selection?.modelId);
    check("model_catalog",!selectionError,selectionError
      ??`${provider.providerId}（${provider.config?.api?.type}）/ ${model.modelId}，档位 ${(model.config?.optionSpecs?.reasoningLevel?.values??[]).join("/")}`);
    const credentialsPath=env.BZS_TITLE_CREDENTIALS??join(homedir(),".zcode","v2","credentials.json");
    const auth=await verifyProviderAuth({provider,credentialsPath,env});
    check("credentials",Boolean(auth.ok),auth.ok
      ?`渠道鉴权就绪（${auth.authType} → ${auth.baseUrl}）`
      :(auth.error??"渠道鉴权未就绪"));
  } catch(error) {
    check("model_catalog",false,error.message);
    check("credentials",false,`${error.reasonCode??"error"}: ${error.message}`);
  }
  return {
    status:checks.every(c=>c.ok)?"ok":"degraded",
    checks,
    sessionDb:config.sessionDb,
    indexDb:config.indexDb
  };
}
