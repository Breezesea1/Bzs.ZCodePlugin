// 宿主模型跟随：从会话库最新 assistant 消息读主对话在用的 providerId/modelId。
// 数据源就是插件已只读打开的 sessionDb（history.mjs 同库），零常驻、零注入。
// 任何失败由调用方降级到 fixed selection，本模块只负责解析并显式报告原因。
import {queryAll} from "./history.mjs";
import {resolveFamily} from "./modelcall.mjs";

// Desktop 内部承载 ID（magpie 的 bzs/group/... 等）直调端点不认（实测 1211 模型不存在），
// 端点接受小写裸模型名（glm-5.3-flash / glm-5.3 均实测 200）：剥聚合前缀 + 小写。
export function normalizeHostModelId(modelId) {
  return String(modelId).replace(/^[\w-]*\/[\w-]*\//,"").toLowerCase();
}

export function resolveHostSelection({dbPath,sessionId}) {
  // json_extract 对残缺 JSON 行会在 SQLite 层抛错，故不用 JSON 函数过滤：
  // 先按 data 含 '"assistant"' 粗筛，再在 JS 侧逐行解析（从新到旧找第一条带合法 provider/model 的 assistant 消息）
  const rows=queryAll(dbPath,`
    SELECT data FROM message
    WHERE session_id=? AND data LIKE '%"assistant"%'
    ORDER BY time_created DESC, id DESC LIMIT 50`,[sessionId]);
  for(const row of rows) {
    let data;
    try {data=JSON.parse(row.data);}
    catch {continue;}
    const {providerId,modelId}=data;
    if(typeof providerId!=="string"||!providerId||typeof modelId!=="string"||!modelId)continue;
    let family;
    try {family=resolveFamily(providerId,modelId);}
    catch(error) {return {status:"host_family_unknown",selection:null,detail:error.message};}
    return {status:"ok",selection:{
      providerId:family,modelId:normalizeHostModelId(modelId),
      // 宿主消息未携带档位：默认 low（标题任务不需要深思考，与 fixed 配置常用值一致）
      options:{reasoningLevel:"low"}
    },source:{providerId,modelId}};
  }
  return {status:"no_host_model",selection:null};
}

// host-follow 的完整解析：宿主模型 → 失败回落 fixed。返回实际 selection 与来源说明。
export function resolveSelection({config,sessionId}) {
  if((config.model?.source??"fixed")!=="host-follow") {
    return {selection:config.selection??null,source:"fixed"};
  }
  const host=resolveHostSelection({dbPath:config.sessionDb,sessionId});
  if(host.status==="ok")return {selection:{
    ...host.selection,
    // 宿主透传标记：模型名是主对话在用的裸名，不在 fixed 候选目录内。
    // backend 据此只校验家族覆盖、跳过模型名精确匹配；来源由此显式标记，不靠 providerId 反推。
    passthrough:true
  },source:"host",sourceModel:host.source};
  // 宿主解析失败：有 fixed selection 就回落，没有则 selection=null 由调用方显式失败
  return {selection:config.selection??null,source:"fixed-fallback",fallbackReason:host.status,detail:host.detail??null};
}
