// 模型直调层：凭据解密 → 项目发现 → 短时 token 铸造 → Anthropic 兼容端点调用。
// 协议自 Desktop 逆向（见 README「直连协议」），零依赖，仅用全局 fetch。
import {createDecipheriv, createHash} from "node:crypto";
import {homedir, platform, userInfo} from "node:os";
import {join} from "node:path";
import {readFile} from "node:fs/promises";

const FAMILIES={
  bigmodel:{origin:"https://bigmodel.cn",anthropicBase:"https://bigmodel.cn/api/anthropic",bearerAuth:false},
  zai:{origin:"https://api.z.ai",anthropicBase:"https://api.z.ai/api/anthropic",bearerAuth:true},
  // MiniMax：官方 Anthropic 兼容端点，静态 Bearer API key（无铸 token 链）
  minimax:{origin:"https://api.minimax.io",anthropicBase:"https://api.minimax.io/anthropic",bearerAuth:true,staticKey:true}
};
// MiniMax 家族：providerId → 目录 providerId 的映射（magpie 聚合承载方为 MiniMax-M3.1-Flash）
export const MINIMAX_MODELS=[
  {modelId:"MiniMax-M3.1-Flash",config:{optionSpecs:{reasoningLevel:{values:["low","medium","high"]}}}},
  {modelId:"MiniMax-M3",config:{optionSpecs:{reasoningLevel:{values:["low","medium","high","xhigh"]}}}}
];
const MINIMAX_KEY_NAME="oauth:minimax:api_key";
const CLIENT_VERSION="3.12.3";
// token 在到期前 refreshBeforeMs 提前重铸，避免调用中途过期
const REFRESH_BEFORE_MS=10*60*1000;

// selection.providerId → 家族。与 Desktop 预设（bigmodel-api / account:bigmodel-*-coding-plan 等）同构。
// modelId 可选：仅 magpie 聚合承载时用于区分 MiniMax 与 GLM（承载方按模型 ID 区分）
export function resolveFamily(providerId,modelId="") {
  const id=String(providerId??"");
  if(id.includes("magpie")&&String(modelId).includes("MiniMax"))return "minimax";
  // magpie 是本地聚合 provider，承载方按模型 ID 区分：MiniMax-M* 走 minimax，其余为 GLM（bigmodel 家族）
  if(id.includes("minimax")||id.includes("MiniMax"))return "minimax";
  if(id.includes("bigmodel")||id.includes("magpie")||id.includes("glm"))return "bigmodel";
  if(id.includes("zai"))return "zai";
  throw Object.assign(new Error(`无法从 providerId 推断模型家族：${providerId}`),{reasonCode:"provider_family_unknown"});
}

function credentialSecret(env=process.env) {
  const explicit=env.ZCODE_CREDENTIAL_SECRET;
  if(explicit)return explicit;
  let user="unknown";
  try {user=userInfo().username;}catch {}
  return `zcode-credential-fallback:${platform()}:${homedir()}:${user}`;
}

export async function loadLoginToken(credentialsPath=join(homedir(),".zcode","v2","credentials.json"),env=process.env) {
  let raw;
  try {raw=await readFile(credentialsPath,"utf8");}
  catch(error) {
    if(error.code==="ENOENT")throw Object.assign(new Error("凭据文件不存在："+credentialsPath),{reasonCode:"credentials_missing"});
    throw error;
  }
  let parsed;
  try {parsed=JSON.parse(raw);}catch {throw Object.assign(new Error("凭据文件 JSON 无效"),{reasonCode:"credentials_invalid"});}
  const stored=parsed["oauth:bigmodel:access_token"];
  if(typeof stored!=="string"||!stored)throw Object.assign(new Error("凭据中缺少 oauth:bigmodel:access_token"),{reasonCode:"credentials_missing"});
  if(!stored.startsWith("enc:v1:"))return stored;
  const [iv,tag,data]=stored.slice(7).split(".");
  if(!iv||!tag||!data)throw Object.assign(new Error("凭据密文格式无效"),{reasonCode:"credentials_invalid"});
  const key=createHash("sha256").update(credentialSecret(env)).digest();
  let plain;
  try {
    const decipher=createDecipheriv("aes-256-gcm",key,Buffer.from(iv,"base64url"));
    decipher.setAuthTag(Buffer.from(tag,"base64url"));
    plain=Buffer.concat([decipher.update(Buffer.from(data,"base64url")),decipher.final()]).toString("utf8").trim();
  }catch {throw Object.assign(new Error("凭据解密失败：密钥或密文不匹配"),{reasonCode:"credentials_decrypt_failed"});}
  if(!plain)throw Object.assign(new Error("解密后凭据为空"),{reasonCode:"credentials_invalid"});
  return plain;
}

async function fetchJson(url,options) {
  let response;
  try {response=await fetch(url,options);}
  catch(error) {throw Object.assign(new Error("网络请求失败："+error.message),{reasonCode:"model_network_error",cause:error});}
  const text=await response.text();
  let body;
  try {body=text?JSON.parse(text):null;}catch {body=null;}
  if(!response.ok||!body) {
    throw Object.assign(new Error(`请求失败 HTTP ${response.status}：${text.slice(0,200)}`),{reasonCode:"model_http_error",httpStatus:response.status});
  }
  return body;
}

// 个人账号的项目发现：默认机构/默认项目优先（与 Desktop 的个人选择策略一致）
export function pickPersonalProject(organizations) {
  const eligible=(organizations??[]).map(org=>({
    ...org,projects:(org.projects??[]).filter(p=>String(p.projectType??"").trim()!=="2")
  })).filter(org=>org.organizationId&&org.projects.length);
  const org=eligible.find(o=>(o.organizationName??"").includes("默认"))??eligible[0];
  const project=org?.projects.find(p=>(p.projectName??"").includes("默认"))??org?.projects[0];
  if(!org?.organizationId||!project?.projectId)throw Object.assign(new Error("账号下没有可用的机构/项目"),{reasonCode:"model_project_unavailable"});
  return {organizationId:org.organizationId,projectId:project.projectId};
}

function keyListUrl(origin,location) {
  return `${origin}/api/biz/v1/organization/${encodeURIComponent(location.organizationId)}/projects/${encodeURIComponent(location.projectId)}/api_keys`;
}

// 铸造短时项目 token（~5h）。location 缓存长存，token 缓存到临期。
export async function mintProjectToken({loginToken,family,credentialsPath,env,now=Date.now}) {
  const endpoint=FAMILIES[family];
  if(!endpoint)throw Object.assign(new Error(`未知模型家族：${family}`),{reasonCode:"provider_family_unknown"});
  // 家族登录态：zai 用自己的 oauth token；bigmodel 用解密出的 access_token
  const authValue=family==="zai"
    ?await loadFamilyToken(credentialsPath,"oauth:zai:access_token",env)
    :loginToken;
  const authHeaders={"Content-Type":"application/json",...(endpoint.bearerAuth?{Authorization:`Bearer ${authValue}`}:{Authorization:authValue})};
  const info=await fetchJson(`${endpoint.origin}/api/biz/customer/getCustomerInfo`,{headers:authHeaders});
  const location=pickPersonalProject(info.data?.organizations);
  const listUrl=keyListUrl(endpoint.origin,location);
  const list=await fetchJson(listUrl,{headers:authHeaders});
  const entries=Array.isArray(list.data)?list.data:[];
  const keyEntry=entries.find(e=>e?.name==="zcode-api-key")
    ??(await fetchJson(listUrl,{method:"POST",headers:authHeaders,body:JSON.stringify({name:"zcode-api-key",usageScene:"CODING_PLAN"})})).data;
  if(!keyEntry?.apiKey)throw Object.assign(new Error("项目 API key 条目无效"),{reasonCode:"model_token_mint_failed"});
  const access=await fetchJson(`${listUrl}/${encodeURIComponent(keyEntry.apiKey)}/access_tokens`,{
    method:"POST",headers:authHeaders,body:JSON.stringify({clientType:"zcode",clientVersion:CLIENT_VERSION})
  });
  const payload=access.data;
  if(!payload?.enabled||!payload.accessToken)throw Object.assign(new Error("项目 token 铸造被拒绝"),{reasonCode:"model_token_mint_failed"});
  return {token:payload.accessToken,expiresAt:now()+ (payload.expiresIn??18000)*1000};
}

async function loadFamilyToken(credentialsPath,key,env) {
  const raw=JSON.parse(await readFile(credentialsPath,"utf8"));
  const stored=raw[key];
  if(typeof stored!=="string"||!stored)throw Object.assign(new Error(`凭据中缺少 ${key}`),{reasonCode:"credentials_missing"});
  if(!stored.startsWith("enc:v1:"))return stored;
  const [iv,tag,data]=stored.slice(7).split(".");
  const cipherKey=createHash("sha256").update(credentialSecret(env)).digest();
  const decipher=createDecipheriv("aes-256-gcm",cipherKey,Buffer.from(iv,"base64url"));
  decipher.setAuthTag(Buffer.from(tag,"base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data,"base64url")),decipher.final()]).toString("utf8").trim();
}

// minimax 家族的静态 API key：enc:v1 加密存于 credentials.json（与 OAuth 条目同套加密）
async function loadMinimaxKey(credentialsPath,env) {
  return loadFamilyToken(credentialsPath,MINIMAX_KEY_NAME,env);
}

// 进程内 token 缓存：worker 短命，但一次 run 可能调 2 次模型（invalid_keep_title 重试）
let cached=null;
export function resetTokenCache() {cached=null;}

// fixed 模式的候选清单（沿用宿主 getView 的视图结构，供 validateSelection / models 命令使用）。
// 它不是宿主能力目录：直调端点接受任意模型名，host-follow 透传时不在此做模型名精确匹配。
export function modelCatalog() {
  return {providers:Object.entries(FAMILIES).map(([family,endpoint])=>({
    providerId:family,
    models:family==="minimax"
      ?MINIMAX_MODELS
      :[
        {modelId:"GLM-5.3-Flash",config:{optionSpecs:{reasoningLevel:{values:["minimal","low","medium","high"]}}}},
        {modelId:"GLM-5.3",config:{optionSpecs:{reasoningLevel:{values:["minimal","low","medium","high","xhigh"]}}}},
        {modelId:"GLM-4.7",config:{optionSpecs:{reasoningLevel:{values:["minimal","low","medium","high","xhigh"]}}}}
      ],
    anthropicBase:endpoint.anthropicBase
  }))};
}

export async function resolveAccessToken({credentialsPath,env=process.env,now=Date.now,providerId}={}) {
  const family=resolveFamily(providerId);
  if(family==="minimax")return loadMinimaxKey(credentialsPath,env);
  if(cached&&now()<cached.expiresAt-REFRESH_BEFORE_MS)return cached.token;
  const loginToken=await loadLoginToken(credentialsPath,env);
  const minted=await mintProjectToken({loginToken,family,credentialsPath,env,now});
  cached={token:minted.token,expiresAt:minted.expiresAt};
  return cached.token;
}

// Anthropic 兼容 messages 调用。messages 为 [{role,content}]，content 为纯文本。
export async function generateText({selection,messages,maxOutputTokens,timeoutMs,credentialsPath,env=process.env,fetchImpl=fetch,now=Date.now}) {
  const family=resolveFamily(selection.providerId);
  const endpoint=FAMILIES[family];
  const token=env.BZS_TITLE_TEST_TOKEN??await resolveAccessToken({credentialsPath,env,now,providerId:selection.providerId});
  const reasoning=selection.options?.reasoningLevel;
  let body;
  if(family==="minimax") {
    // MiniMax M3.1-Flash 始终思考（effort 缺省 max），思考与 text 共享 max_tokens，
    // 与 GLM 同款抬顶避免 text 块被挤没；effort 映射自 selection 档位（档位名一致，xhigh→xhigh）。
    const effortMap={minimal:"low",low:"low",medium:"medium",high:"high",xhigh:"xhigh"};
    body={
      model:selection.modelId,
      messages,
      max_tokens:Math.max(maxOutputTokens,8192),
      output_config:{effort:effortMap[reasoning]??"medium"}
    };
  } else {
    // thinking 档位下思考与 text 共享 max_tokens，GLM 实际思考可达 3-4k tokens；
    // 标题 JSON 本身很小，请求时按需抬高上限避免 text 块被思考挤没（计费按实际用量）。
    const budget=reasoning&&reasoning!=="minimal"
      ?{max_tokens:Math.max(maxOutputTokens,8192),thinking:{type:"enabled",budget_tokens:4096}}
      :{max_tokens:maxOutputTokens};
    body={model:selection.modelId,messages,...budget};
  }
  let response;
  try {
    response=await fetchImpl(`${endpoint.anthropicBase}/v1/messages`,{
      method:"POST",
      headers:{"content-type":"application/json","anthropic-version":"2023-06-01","x-api-key":token,authorization:`Bearer ${token}`},
      body:JSON.stringify(body),
      signal:AbortSignal.timeout(timeoutMs)
    });
  }catch(error) {
    throw Object.assign(new Error("模型请求失败："+error.message),{reasonCode:"model_request_failed",cause:error});
  }
  const text=await response.text();
  let payload;
  try {payload=JSON.parse(text);}catch {payload=null;}
  if(!response.ok||!payload) {
    throw Object.assign(new Error(`模型返回 HTTP ${response.status}：${text.slice(0,200)}`),{reasonCode:"model_http_error",httpStatus:response.status});
  }
  if(payload.type==="error") {
    throw Object.assign(new Error("模型错误："+(payload.error?.message??"unknown")),{reasonCode:"model_error"});
  }
  const textBlock=(payload.content??[]).find(b=>b.type==="text");
  return {
    text:textBlock?.text??"",
    finishReason:payload.stop_reason==="end_turn"?"stop":payload.stop_reason??"stop",
    toolCalls:payload.content?.filter(b=>b.type==="tool_use")??[],
    usage:payload.usage?{input_tokens:payload.usage.input_tokens,output_tokens:payload.usage.output_tokens}:null
  };
}
