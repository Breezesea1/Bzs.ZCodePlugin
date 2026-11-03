// 标题生成与护栏编排。模型输出经过严格校验；改名前先检查标题策略/状态漂移，
// 改名后读回复核。状态文件记录 pendingTitle/lastFingerprint 用于跨轮对账与手动改名保护。
import {summarizeContext} from "./history.mjs";

const DEFAULT_EMOJI=["🎬","🧩","🧪","📋","🔎","📝","📅","🎨","⚙️","💬"];

export function titleFormatError(title,{maxChars=48,minChars=6,requireFormat=true,emoji=DEFAULT_EMOJI}={}) {
  if(typeof title!=="string"||title!==title.trim())return "标题首尾不能有空白";
  const count=[...title].length;
  if(count<minChars||count>maxChars)return `标题长度需在 ${minChars}–${maxChars} 个字符之间`;
  if(!requireFormat)return null;
  const prefix=emoji.find(e=>title.startsWith(e+" "));
  if(!prefix)return "标题必须以类别 emoji + 空格开头";
  const body=title.slice(prefix.length+1),pieces=body.split("｜");
  if(pieces.length!==2||pieces.some(p=>!p||p!==p.trim()))return "标题必须采用对象｜目标格式";
  if(/[\p{Cc}\p{Cf}\u0060|@]|\p{Extended_Pictographic}/u.test(body)||/[A-Za-z]:[\\/]|\\\\|https?:\/\/|\/Users\/|sk-/i.test(title))return "标题包含不允许的格式或私人信息";
  return null;
}

export function candidateFrom(result,currentTitle,options={}) {
  if(result.finishReason!=="stop")throw new Error("模型结束原因不是正常完成");
  if(result.toolCalls?.length)throw new Error("总结模型返回了工具调用");
  const value=JSON.parse(result.text);
  if(Object.keys(value).sort().join(",")!=="action,reason,title"||!["keep","rename"].includes(value.action)||typeof value.title!=="string"||typeof value.reason!=="string")throw new Error("总结输出字段无效");
  if(/https?:\/\/|\b(?:device_)?(?:sid|hash|mid)["']?\s*[=:]|\bsk-|[A-Za-z]:[\\/]|\\\\|\/Users\//i.test(value.reason))throw new Error("总结理由包含不允许的链接、凭据或私人路径");
  const requireFormat=options.requireFormat!==false;
  // requireFormat=false：格式不作要求，keep/rename 都按模型原样返回
  if(!requireFormat)return{...value,title:value.title};
  // requireFormat=true：keep 沿用当前标题——若当前标题本身违规，keep 无法消除，
  // 标记 invalid_keep_title 让调用方带反馈重试；rename 校验模型给出的新标题。
  const title=value.action==="keep"?currentTitle:value.title;
  const invalid=titleFormatError(title,{...options,requireFormat:true});
  if(invalid)throw Object.assign(new Error(invalid),{code:value.action==="keep"?"invalid_keep_title":"invalid_title"});
  return {...value,title};
}

// 一次完整的命名决策。apply=false 只预览；apply=true 执行改名并落状态。
export async function runNaming({backend,selection,state={},apply=false,eventUserId,renameOptions={}}) {
  const before=await backend.read();
  if(before.archived||before.deleted)return{status:"archived",title:before.title};
  if(before.running)return{status:"running",title:before.title};
  if(!before.turnCount)return{status:"empty",title:before.title};
  if(eventUserId&&eventUserId!==before.latestUserId)return{status:"outdated_event",title:before.title};
  state={...state};
  // 上轮 rename 后宿主异步落库：pendingTitle 与当前标题一致时才确认成功
  if(state.pendingTitle===before.title) {
    state.lastTitle=before.title;state.lastFingerprint=state.pendingFingerprint;
    delete state.pendingTitle;delete state.pendingFingerprint;
    if(apply)await backend.saveState(state);
  }
  if(before.titlePolicy?.locked)return{status:"locked",title:before.title};
  if(before.titlePolicy)delete state.locked;
  if(state.locked)return{status:"locked",title:before.title};
  // 标题变化且非宿主自动生成（generated）才视为用户手动改名并锁定
  if(!before.titlePolicy&&state.lastFingerprint&&state.lastTitle!==before.title&&before.titleSource!=="generated") {
    if(apply)await backend.saveState({...state,locked:true,lastTitle:before.title});
    return{status:"manual_title",title:before.title};
  }
  const requireFormat=before.titlePolicy?.locked===false||renameOptions.requireFormat;
  const options={...renameOptions,requireFormat};
  if(state.lastFingerprint===before.fingerprint&&state.lastTitle===before.title&&(!requireFormat||!titleFormatError(before.title,options)))return{status:"unchanged",title:before.title};
  // 总结上下文：原始目标 + 最近 N 轮（含 project_hint），与漂移指纹绑定在同一份 read 上
  const context={
    current_title:before.title,
    ...summarizeContext({turns:before.turns,projectHint:renameOptions.projectHint,maxTurns:renameOptions.maxTurns})
  };
  const finalContext=requireFormat?{...context,title_format_required:true}:context;
  let generated=await backend.generate(finalContext,selection),candidate;
  try {candidate=candidateFrom(generated,before.title,options);}
  catch(error) {
    if(error.code!=="invalid_keep_title")throw error;
    // keep 的原标题不符合统一结构：追加反馈重试一次，要求 rename
    const firstUsage=generated.usage;
    generated=await backend.generate({...finalContext,title_format_feedback:"原标题不符合规范，不能 keep；请返回 rename 与合法的类别 对象｜目标标题"},selection);
    if(firstUsage&&generated.usage)generated.usage=Object.fromEntries(Object.keys(generated.usage).map(key=>[key,(firstUsage[key]??0)+generated.usage[key]]));
    candidate=candidateFrom(generated,before.title,{...options,requireFormat:true});
  }
  const result={status:"preview",action:candidate.action,title:candidate.title,reason:candidate.reason,usage:generated.usage};
  if(!apply)return result;
  const fresh=await backend.read();
  if(fresh.titlePolicy?.locked)return{status:"locked",title:fresh.title,usage:generated.usage};
  if(fresh.archived||fresh.deleted)return{status:"archived",title:fresh.title,usage:generated.usage};
  // 宿主自动命名只改变标题时可继续 rename；keep 仍基于原标题，不能沿用。
  const canReplaceGeneratedTitle=fresh.titleSource==="generated"&&candidate.action==="rename";
  const staleReason=fresh.running?"running":fresh.fingerprint!==before.fingerprint?"fingerprint":fresh.title!==before.title&&!canReplaceGeneratedTitle?"title":null;
  if(staleReason)return{status:"stale_result",staleReason,title:fresh.title,usage:generated.usage};
  if(candidate.action==="rename"&&candidate.title!==fresh.title) {
    await backend.saveState({...state,pendingTitle:candidate.title,pendingFingerprint:before.fingerprint});
    await backend.rename(candidate.title);
    const verified=await backend.read();
    if(verified.title!==candidate.title)throw new Error("原宿主改名后读回不一致");
    result.status="renamed";
  }else result.status="kept";
  await backend.saveState({...state,lastFingerprint:before.fingerprint,lastTitle:candidate.title,lastUserId:before.latestUserId,updatedAt:new Date().toISOString()});
  return result;
}
