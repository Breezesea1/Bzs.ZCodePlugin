// 环境与链路自检：不改动任何状态，只汇报各环节是否就绪。
import {readHistory} from "./history.mjs";

export async function runDoctor({backend,event,config}) {
  const checks=[];
  const check=(name,ok,detail)=>checks.push({name,ok,detail:detail??null});
  // 1. 配置与模型选择
  check("selection",!!config.selection,config.selection?`${config.selection.providerId} / ${config.selection.modelId} / ${config.selection.options?.reasoningLevel}`:"未配置模型选择");
  // 2. 会话定位（SQLite）
  try {
    const history=await readHistory({dbPath:config.sessionDb,sqliteBin:config.sqliteBin,sessionId:event.session_id,workspacePath:event.workspace_path??event.cwd});
    const snapshot=await backend.read();
    check("history",true,`会话标题「${history.session.title}」，有效对话轮 ${snapshot.turns.length}，指纹 ${snapshot.fingerprint.slice(0,12)}…`);
  } catch(error) {
    check("history",false,error.message);
  }
  // 3. 网关与原宿主
  const {probeHost}=await import("./gateway/connect.mjs");
  const probed=await probeHost({
    workspacePath:event.workspace_path??event.cwd,
    sessionId:event.session_id,
    gatewayConfigPath:config.gatewayConfigPath,
    timeoutMs:config.probeTimeoutMs??8000
  });
  check("gateway",probed.ok,probed.ok?"网关与原宿主就绪":`${probed.reasonCode}: ${probed.message}`);
  // 4. 模型目录可达
  if(probed.ok) {
    try {
      const view=await backend.models();
      const provider=(view.providers??[]).find(p=>p.providerId===config.selection?.providerId);
      const model=provider?.models?.find(m=>m.modelId===config.selection?.modelId);
      check("model_catalog",!!model,model?`${model.modelId} 档位 ${(model.config?.optionSpecs?.reasoningLevel?.values??[]).join("/")}`:"所选模型不在可用目录中");
    } catch(error) {
      check("model_catalog",false,error.message);
    }
  } else check("model_catalog",false,"网关未就绪，跳过");
  return {
    status:checks.every(c=>c.ok)?"ok":"degraded",
    checks,
    sessionDb:config.sessionDb,
    indexDb:config.indexDb,
    gatewayConfigPath:config.gatewayConfigPath
  };
}
