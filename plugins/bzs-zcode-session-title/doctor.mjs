// 环境与链路自检：不改动任何状态，只汇报各环节是否就绪。
import {readHistory} from "./history.mjs";
import {indexReachable} from "./taskstore.mjs";
import {loadLoginToken,resolveFamily} from "./modelcall.mjs";
import {homedir} from "node:os";
import {join} from "node:path";

export async function runDoctor({backend,event,config}) {
  const checks=[];
  const check=(name,ok,detail)=>checks.push({name,ok,detail:detail??null});
  // 1. 配置与模型选择
  check("selection",!!config.selection,config.selection?`${config.selection.providerId} / ${config.selection.modelId} / ${config.selection.options?.reasoningLevel}`:"未配置模型选择");
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
  // 4. 凭据解密
  let credentialsOk=false;
  try {
    const token=await loadLoginToken(join(homedir(),".zcode","v2","credentials.json"));
    credentialsOk=token.length>0;
    check("credentials",credentialsOk,`登录凭据解密成功（${resolveFamily(config.selection?.providerId)} 家族）`);
  } catch(error) {
    check("credentials",false,`${error.reasonCode??"error"}: ${error.message}`);
  }
  // 5. 模型目录
  try {
    const view=await backend.models();
    const provider=(view.providers??[]).find(p=>p.providerId===resolveFamily(config.selection?.providerId));
    const model=provider?.models?.find(m=>m.modelId===config.selection?.modelId);
    check("model_catalog",!!model,model?`${model.modelId} 档位 ${(model.config?.optionSpecs?.reasoningLevel?.values??[]).join("/")}`:"所选模型不在直连目录中");
  } catch(error) {
    check("model_catalog",false,error.message);
  }
  return {
    status:checks.every(c=>c.ok)?"ok":"degraded",
    checks,
    sessionDb:config.sessionDb,
    indexDb:config.indexDb
  };
}
