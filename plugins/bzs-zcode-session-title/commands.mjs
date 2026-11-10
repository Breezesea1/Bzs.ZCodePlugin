// CLI 命令实现：每条命令一个函数，输入输出都是可 JSON 序列化的对象。
// 进程事务（argv/stdin 解析、worker 互斥、日志、退出码）由 cli.mjs 处理，
// 本模块不触碰 process 与 stdin；数据访问在 history.mjs/taskstore.mjs，模型调用在 modelcall.mjs。
import {readFile} from "node:fs/promises";
import {basename,join} from "node:path";
import {runNaming} from "./naming.mjs";
import {runDoctor} from "./doctor.mjs";
import {readTitlePolicy,writeTitlePolicy} from "./vendor/title-policy.mjs";
import {readJsonOptional,writeJsonAtomic} from "./fsutil.mjs";
import {modelCatalog,loadLoginToken,resolveFamily} from "./modelcall.mjs";
import {indexReachable} from "./taskstore.mjs";
import {homedir} from "node:os";

// prompt.md 含按配置渲染的占位符，注入模型前替换
export async function loadPrompt(pluginRoot,config) {
  const template=await readFile(join(pluginRoot,"prompt.md"),"utf8");
  return template.replaceAll("{{max_title_chars}}",String(config.rename.maxTitleChars));
}

async function commandRun({backend,event,config,apply,statePath}) {
  let state=await readJsonOptional(statePath)??{};
  // 模型来源解析：host-follow 时主对话模型优先，失败回落 fixed（固定选择缺失则显式失败）
  const {resolveSelection}=await import("./hostcatalog.mjs");
  const resolved=resolveSelection({config,sessionId:event.session_id});
  if(!resolved.selection) {
    throw Object.assign(new Error(`宿主模型解析失败（${resolved.fallbackReason}）且未配置 fixed selection`),{reasonCode:"selection_unavailable"});
  }
  const result=await runNaming({
    backend,selection:resolved.selection,state,apply,
    eventUserId:event.user_message_id,
    renameOptions:{
      maxTurns:config.rename.maxTurns,
      projectHint:basename(event.workspace_path??event.cwd??""),
      maxTitleChars:config.rename.maxTitleChars,
      minTitleChars:config.rename.minTitleChars,
      requireFormat:config.rename.requireFormat
    }
  });
  return {...result,sessionId:event.session_id,selection:resolved.selection,
    modelSource:resolved.source,sourceModel:resolved.sourceModel??null,fallbackReason:resolved.fallbackReason??null};
}

async function commandModels() {
  // 直连模式：目录是本模块的静态定义，不发网络请求
  const view=modelCatalog();
  return {status:"models",providers:view.providers.map(p=>({
    providerId:p.providerId,
    models:p.models.map(m=>({modelId:m.modelId,reasoningLevels:m.config?.optionSpecs?.reasoningLevel?.values??[]}))
  }))};
}

async function commandProbe({config}) {
  // 直连自检：凭据解密 + 任务索引可达
  const checks={};
  try {
    const token=await loadLoginToken(join(homedir(),".zcode","v2","credentials.json"));
    checks.credentials={ok:token.length>0,family:resolveFamily(config.selection?.providerId)};
  } catch(error) {
    checks.credentials={ok:false,error:`${error.reasonCode??"error"}: ${error.message}`};
  }
  checks.taskIndex={ok:indexReachable(config.indexDb)};
  const ok=checks.credentials.ok&&checks.taskIndex.ok;
  return {status:ok?"probe_ok":"probe_failed",ok,...checks};
}

async function commandEnableDisable({command,configPath}) {
  const current=await readJsonOptional(configPath)??{};
  current.enabled=command==="enable";
  await writeJsonAtomic(configPath,current);
  return {status:command==="enable"?"enabled":"disabled",enabled:current.enabled};
}

async function commandTitlePolicy({command,backend,event,config}) {
  if(!await backend.sessionExists())throw new Error("目标会话在索引与会话库中均不存在");
  const directory=config.titlePolicyDirectory||undefined;
  if(command==="policy") {
    return {status:"policy",sessionId:event.session_id,policy:await readTitlePolicy({sessionId:event.session_id,directory})};
  }
  const locked=command==="lock";
  const previous=await readTitlePolicy({sessionId:event.session_id,directory});
  await writeTitlePolicy({sessionId:event.session_id,locked,directory});
  const policy=await readTitlePolicy({sessionId:event.session_id,directory});
  if(policy?.locked!==locked)throw new Error("标题策略写后复核不一致");
  return {status:locked?"locked":"unlocked",sessionId:event.session_id,previous,policy};
}

export async function executeCommand({command,event,config,configPath,dataDir,backend,apply,statePath}) {
  switch(command) {
    case "run":return commandRun({backend,event,config,apply,statePath});
    case "doctor":return runDoctor({backend,event,config});
    case "models":return commandModels();
    case "probe":return commandProbe({event,config});
    case "status":return {status:"status",enabled:config.enabled!==false,selection:config.selection??null,dataDir,rename:config.rename};
    case "enable":case "disable":return commandEnableDisable({command,configPath});
    case "lock":case "unlock":case "policy":return commandTitlePolicy({command,backend,event,config});
    default:throw new Error("未知命令");
  }
}
