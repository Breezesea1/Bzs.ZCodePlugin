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
  const modelSource=config.model?.source??"fixed";
  check("selection",!!config.selection||modelSource==="host-follow",
    config.selection
      ?`${config.selection.providerId} / ${config.selection.modelId} / ${config.selection.options?.reasoningLevel}（来源 ${modelSource}${modelSource==="host-follow"?"，失败回落此配置":""}）`
      :`未配置 fixed selection（model.source=${modelSource}）`);
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
  // 4. 凭据解密（直连凭据从 Desktop 凭据文件本地解密；失败只报告、不阻塞其它检查）
  let credentialsOk=false;
  try {
    const token=await loadLoginToken(join(homedir(),".zcode","v2","credentials.json"));
    credentialsOk=token.length>0;
    check("credentials",credentialsOk,`登录凭据解密成功（${resolveFamily(config.selection?.providerId)} 家族）`);
  } catch(error) {
    check("credentials",false,`${error.reasonCode??"error"}: ${error.message}`);
  }
  // 5. 模型目录（0.4.0 起无网关，直连静态目录）
  try {
    const view=await backend.models();
    // host-follow：先解析主对话模型，展示实际将用的 selection；失败回落 fixed 并注明原因
    let effective=config.selection,followNote=null,hostResolved=false;
    if(modelSource==="host-follow") {
      const {resolveHostSelection}=await import("./hostcatalog.mjs");
      const host=resolveHostSelection({dbPath:config.sessionDb,sessionId:event.session_id});
      if(host.status==="ok") {effective=host.selection;followNote=`host-follow → ${host.source.providerId}/${host.source.modelId}（家族 ${host.selection.providerId}）`;hostResolved=true;}
      else {followNote=`host-follow 解析失败（${host.status}）→ 回落 fixed${config.selection?"":"，但未配置 fixed selection！"}`;}
    }
    if(!effective) {
      check("model_catalog",false,followNote??"未配置 selection 且非 host-follow 模式");
    } else if(modelSource==="host-follow"&&hostResolved) {
      // host-follow 透传模型名：直调端点接受任意模型名，目录只校验家族覆盖，不精确匹配承载 ID
      const provider=(view.providers??[]).find(p=>p.providerId===effective.providerId);
      check("model_catalog",!!provider,provider
        ?`${followNote}：家族 ${effective.providerId} 在直连目录（端点透传模型名）`
        :`${followNote}：家族 ${effective.providerId} 不在直连目录中`);
    } else {
      const provider=(view.providers??[]).find(p=>p.providerId===resolveFamily(effective.providerId,effective.modelId));
      const model=provider?.models?.find(m=>m.modelId===effective.modelId);
      check("model_catalog",!!model,model?`${followNote?followNote+"：":""}${model.modelId} 档位 ${(model.config?.optionSpecs?.reasoningLevel?.values??[]).join("/")}`:`${followNote?followNote+"：":""}模型 ${effective.modelId} 不在直连目录中`);
    }
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
