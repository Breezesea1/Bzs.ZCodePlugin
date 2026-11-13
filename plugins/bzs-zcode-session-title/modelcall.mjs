// 模型直调层：按宿主模型目录解析出的渠道配置（API 协议、baseUrl、鉴权方式与 optionSpecs），
// 直接调用对应端点（anthropic-messages / openai-responses / openai-chat-completions）。
import {homedir} from "node:os";
import {join} from "node:path";
import {applyOptionSpecs,decryptCredentialValue,loadHostCatalog,readCredentials} from "./hostcatalog.mjs";

const ACCOUNT_ENDPOINTS={
  bigmodel:{origin:"https://bigmodel.cn",anthropicBase:"https://bigmodel.cn/api/anthropic",bearerAuth:false,oauthKey:"oauth:bigmodel:access_token"},
  zai:{origin:"https://api.z.ai",anthropicBase:"https://api.z.ai/api/anthropic",bearerAuth:true,oauthKey:"oauth:zai:access_token"}
};
const CLIENT_VERSION="3.17.2";
const REFRESH_BEFORE_MS=10*60*1000;

export async function loadAccountLoginToken(accountType,credentialsPath=join(homedir(),".zcode","v2","credentials.json"),env=process.env) {
  const endpoint=ACCOUNT_ENDPOINTS[accountType];
  if(!endpoint)throw Object.assign(new Error(`未知官方账号类型：${accountType}`),{reasonCode:"provider_family_unknown"});
  const parsed=await readCredentials(credentialsPath,env);
  if(!parsed)throw Object.assign(new Error("凭据文件不存在："+credentialsPath),{reasonCode:"credentials_missing"});
  const stored=parsed[endpoint.oauthKey];
  if(typeof stored!=="string"||!stored)throw Object.assign(new Error(`凭据中缺少 ${endpoint.oauthKey}`),{reasonCode:"credentials_missing"});
  const plain=decryptCredentialValue(stored,env,{credentialsPath});
  if(!plain)throw Object.assign(new Error("解密后凭据为空"),{reasonCode:"credentials_invalid"});
  return plain;
}

async function fetchJson(url,options,fetchImpl=fetch) {
  let response;
  try {response=await fetchImpl(url,options);}
  catch(error) {throw Object.assign(new Error("网络请求失败："+error.message),{reasonCode:"model_network_error",cause:error});}
  const text=await response.text();
  let body;
  try {body=text?JSON.parse(text):null;}catch {body=null;}
  if(!response.ok||!body) {
    throw Object.assign(new Error(`请求失败 HTTP ${response.status}：${text.slice(0,200)}`),{reasonCode:"model_http_error",httpStatus:response.status});
  }
  if(body.success===false) {
    const authFailed=body.code===401||body.code===403||body.code==="401"||body.code==="403";
    throw Object.assign(
      new Error(`接口返回错误（code=${body.code??"unknown"}）：${body.msg??body.message??"请求被拒绝"}`),
      {reasonCode:authFailed?"credentials_invalid":"model_http_error",httpStatus:response.status}
    );
  }
  return body;
}

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

export async function mintProjectToken({loginToken,accountType,teamLocation=null,fetchImpl=fetch,now=Date.now}) {
  const endpoint=ACCOUNT_ENDPOINTS[accountType];
  if(!endpoint)throw Object.assign(new Error(`未知官方账号类型：${accountType}`),{reasonCode:"provider_family_unknown"});
  const authHeaders={"Content-Type":"application/json",...(endpoint.bearerAuth?{Authorization:`Bearer ${loginToken}`}:{Authorization:loginToken})};
  let location=teamLocation;
  if(!location) {
    const info=await fetchJson(`${endpoint.origin}/api/biz/customer/getCustomerInfo`,{headers:authHeaders},fetchImpl);
    location=pickPersonalProject(info.data?.organizations);
  }
  const listUrl=keyListUrl(endpoint.origin,location);
  const list=await fetchJson(listUrl,{headers:authHeaders},fetchImpl);
  const entries=Array.isArray(list.data)?list.data:[];
  const keyEntry=entries.find(e=>e?.name==="zcode-api-key")
    ??(await fetchJson(listUrl,{method:"POST",headers:authHeaders,body:JSON.stringify({name:"zcode-api-key",usageScene:"CODING_PLAN"})},fetchImpl)).data;
  if(!keyEntry?.apiKey)throw Object.assign(new Error("项目 API key 条目无效"),{reasonCode:"model_token_mint_failed"});
  const access=await fetchJson(`${listUrl}/${encodeURIComponent(keyEntry.apiKey)}/access_tokens`,{
    method:"POST",headers:authHeaders,body:JSON.stringify({clientType:"zcode",clientVersion:CLIENT_VERSION})
  },fetchImpl);
  const payload=access.data;
  if(!payload?.enabled||!payload.accessToken)throw Object.assign(new Error("项目 token 铸造被拒绝"),{reasonCode:"model_token_mint_failed"});
  return {token:payload.accessToken,expiresAt:now()+(payload.expiresIn??18000)*1000};
}

const tokenCache=new Map();
export function resetTokenCache() {tokenCache.clear();}

async function resolveAccountToken({access,credentialsPath,env=process.env,fetchImpl=fetch,now=Date.now}) {
  const cacheKey=JSON.stringify([access.accountType,access.teamLocation??null]);
  const hit=tokenCache.get(cacheKey);
  if(hit&&now()<hit.expiresAt-REFRESH_BEFORE_MS)return hit.token;
  const loginToken=await loadAccountLoginToken(access.accountType,credentialsPath,env);
  const minted=await mintProjectToken({loginToken,accountType:access.accountType,teamLocation:access.teamLocation??null,fetchImpl,now});
  tokenCache.set(cacheKey,minted);
  return minted.token;
}

// 供 doctor / probe 校验所选渠道的凭据是否就绪（不发起大模型推理请求）
export async function verifyProviderAuth({provider,credentialsPath=join(homedir(),".zcode","v2","credentials.json"),env=process.env}) {
  if(!provider)return {ok:false,error:"渠道不在宿主可用模型目录中"};
  const access=provider.config?.access;
  const api=provider.config?.api;
  if(access?.type==="zhipu-account") {
    const token=await loadAccountLoginToken(access.accountType,credentialsPath,env);
    return {ok:token.length>0,authType:`zhipu-account:${access.accountType}`,apiType:api?.type,baseUrl:ACCOUNT_ENDPOINTS[access.accountType]?.anthropicBase??api?.baseUrl};
  }
  const apiKey=access?.apiKey?.trim();
  if(!apiKey)return {ok:false,error:`渠道 ${provider.providerId} 缺少 API Key`};
  return {ok:true,authType:access?.type??"api-key",apiType:api?.type,baseUrl:api?.baseUrl};
}

export function normalizeAnthropicBaseUrl(baseUrl) {
  const trimmed=String(baseUrl??"").trim();
  try {
    const u=new URL(trimmed);
    const cleanPath=u.pathname.replace(/\/+$/u,"");
    u.pathname=cleanPath.toLowerCase().endsWith("/v1")?cleanPath:`${cleanPath}/v1`;
    return u.href.replace(/\/+$/u,"");
  }catch {
    const clean=trimmed.replace(/\/+$/u,"");
    return clean.toLowerCase().endsWith("/v1")?clean:`${clean}/v1`;
  }
}

function isOpenRouterUrl(baseUrl) {
  try {
    const host=new URL(baseUrl).hostname.toLowerCase();
    return host==="openrouter.ai"||host.endsWith(".openrouter.ai");
  }catch {return false;}
}

function mergeHeaders(...groups) {
  const out={};
  for(const group of groups) {
    for(const [k,v] of Object.entries(group??{})) {
      if(v===undefined||v===null)continue;
      for(const existing of Object.keys(out)) {
        if(existing.toLowerCase()===k.toLowerCase())delete out[existing];
      }
      out[k]=v;
    }
  }
  return out;
}

function unwrapJsonFence(text) {
  const trimmed=String(text??"").trim();
  const match=/^```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```$/i.exec(trimmed);
  return match?match[1].trim():text;
}

function throwIfBusinessError(payload) {
  if(!payload||typeof payload!=="object")return;
  if(payload.type==="error"||payload.error) {
    const msg=typeof payload.error==="string"?payload.error:(payload.error?.message??payload.error?.msg??payload.message??payload.msg??"unknown");
    throw Object.assign(new Error("模型错误："+msg),{reasonCode:"model_error"});
  }
  if(payload.success===false||(payload.code!==undefined&&payload.code!==0&&payload.code!=="0"&&!payload.content&&!payload.choices&&!payload.output)) {
    throw Object.assign(new Error("模型错误："+(payload.msg??payload.message??`code=${payload.code}`)),{reasonCode:"model_error"});
  }
}

function parseSseFrames(rawText) {
  const events=[];
  for(const block of rawText.split(/\r\n\r\n|\n\n|\r\r/)) {
    const dataLines=[];
    let eventName=null;
    for(const line of block.split(/\r\n|\n|\r/)) {
      if(line.startsWith("event:"))eventName=line.slice(6).trim();
      else if(line.startsWith("data:"))dataLines.push(line.slice(5).trimStart());
    }
    const joined=dataLines.join("\n").trim();
    if(!joined||joined==="[DONE]")continue;
    try {events.push({event:eventName,data:JSON.parse(joined)});}catch {}
  }
  return events;
}

function parseAnthropicResponse(payload,rawText,isSse) {
  if(isSse) {
    const frames=parseSseFrames(rawText);
    let text="",stopReason="stop",usage=null;
    const toolCalls=[];
    for(const {event,data} of frames) {
      if(event==="error"||data?.type==="error")throwIfBusinessError(data);
      if(data?.type==="content_block_start") {
        if(data.content_block?.type==="text"&&data.content_block.text)text+=data.content_block.text;
        if(data.content_block?.type==="tool_use")toolCalls.push(data.content_block);
      } else if(data?.type==="content_block_delta"&&data.delta?.type==="text_delta") {
        text+=data.delta.text??"";
      } else if(data?.type==="message_delta") {
        if(data.delta?.stop_reason)stopReason=data.delta.stop_reason==="end_turn"?"stop":data.delta.stop_reason;
        if(data.usage)usage={...(usage??{}),...data.usage};
      } else if(data?.type==="message_start"&&data.message?.usage) {
        usage={...data.message.usage};
      }
    }
    return {
      text:unwrapJsonFence(text),
      finishReason:stopReason,
      toolCalls,
      usage:usage?{input_tokens:usage.input_tokens??0,output_tokens:usage.output_tokens??0}:null
    };
  }
  throwIfBusinessError(payload);
  const textBlocks=(payload.content??[]).filter(b=>b?.type==="text").map(b=>b.text??"").join("");
  return {
    text:unwrapJsonFence(textBlocks),
    finishReason:payload.stop_reason==="end_turn"?"stop":(payload.stop_reason??"stop"),
    toolCalls:(payload.content??[]).filter(b=>b?.type==="tool_use"),
    usage:payload.usage?{input_tokens:payload.usage.input_tokens,output_tokens:payload.usage.output_tokens}:null
  };
}

function parseOpenAiResponses(payload,rawText,isSse) {
  if(isSse) {
    const frames=parseSseFrames(rawText);
    let completed=null,text="";
    const toolCalls=[];
    for(const {event,data} of frames) {
      if(event==="error"||data?.type==="error")throwIfBusinessError(data);
      if(data?.type==="response.output_text.delta")text+=data.delta??"";
      else if(data?.type==="response.output_item.done"&&data.item?.type==="function_call")toolCalls.push(data.item);
      else if(data?.type==="response.completed"&&data.response)completed=data.response;
    }
    if(completed)return parseOpenAiResponses(completed,"",false);
    return {text:unwrapJsonFence(text),finishReason:"stop",toolCalls,usage:null};
  }
  throwIfBusinessError(payload);
  const output=Array.isArray(payload.output)?payload.output:[];
  const textParts=[];
  const toolCalls=[];
  for(const item of output) {
    if(item?.type==="message"&&Array.isArray(item.content)) {
      for(const part of item.content) {
        if((part?.type==="output_text"||part?.type==="text")&&typeof part.text==="string")textParts.push(part.text);
      }
    } else if(item?.type==="function_call") {
      toolCalls.push(item);
    }
  }
  const text=textParts.length>0?textParts.join(""):(typeof payload.output_text==="string"?payload.output_text:"");
  const finishReason=payload.status==="incomplete"
    ?(payload.incomplete_details?.reason??"length")
    :(payload.status==="completed"||!payload.status?"stop":payload.status);
  return {
    text:unwrapJsonFence(text),
    finishReason,
    toolCalls,
    usage:payload.usage?{input_tokens:payload.usage.input_tokens,output_tokens:payload.usage.output_tokens}:null
  };
}

function parseOpenAiChatCompletions(payload,rawText,isSse) {
  if(isSse) {
    const frames=parseSseFrames(rawText);
    let text="",finishReason="stop",usage=null;
    const toolCalls=[];
    for(const {event,data} of frames) {
      if(event==="error")throwIfBusinessError(data);
      if(data?.error)throwIfBusinessError(data);
      const choice=data?.choices?.[0];
      if(choice?.delta?.content)text+=choice.delta.content;
      if(Array.isArray(choice?.delta?.tool_calls))toolCalls.push(...choice.delta.tool_calls);
      if(choice?.finish_reason)finishReason=choice.finish_reason==="stop"?"stop":choice.finish_reason;
      if(data?.usage)usage=data.usage;
    }
    return {
      text:unwrapJsonFence(text),
      finishReason,
      toolCalls,
      usage:usage?{input_tokens:usage.prompt_tokens??usage.input_tokens,output_tokens:usage.completion_tokens??usage.output_tokens}:null
    };
  }
  throwIfBusinessError(payload);
  const choice=payload.choices?.[0];
  const rawContent=choice?.message?.content;
  const text=typeof rawContent==="string"
    ?rawContent
    :Array.isArray(rawContent)?rawContent.filter(p=>p?.type==="text").map(p=>p.text??"").join(""):"";
  return {
    text:unwrapJsonFence(text),
    finishReason:choice?.finish_reason==="stop"?"stop":(choice?.finish_reason??"stop"),
    toolCalls:choice?.message?.tool_calls??[],
    usage:payload.usage?{input_tokens:payload.usage.prompt_tokens??payload.usage.input_tokens,output_tokens:payload.usage.completion_tokens??payload.usage.output_tokens}:null
  };
}

// 统一模型生成入口：根据宿主目录中的 provider / model 配置直调对应协议端点。
export async function generateText({selection,provider,model,catalog,messages,maxOutputTokens,timeoutMs,credentialsPath,env=process.env,fetchImpl=fetch,now=Date.now}) {
  let resolvedProvider=provider;
  let resolvedModel=model;
  if(!resolvedProvider||!resolvedModel) {
    const view=catalog??await loadHostCatalog({env});
    resolvedProvider??=(view.providers??[]).find(p=>p.providerId===selection.providerId);
    resolvedModel??=resolvedProvider?.models?.find(m=>m.modelId===selection.modelId);
  }
  if(!resolvedProvider)throw Object.assign(new Error(`渠道不在宿主可用模型目录中：${selection.providerId}`),{reasonCode:"provider_not_found"});
  if(!resolvedModel)throw Object.assign(new Error(`模型不在宿主可用模型目录中：${selection.providerId}/${selection.modelId}`),{reasonCode:"model_not_found"});

  const access=resolvedProvider.config.access;
  let apiType=resolvedProvider.config.api.type;
  let baseUrl=resolvedProvider.config.api.baseUrl;
  let token;

  if(access.type==="zhipu-account") {
    // 官方账号渠道（Start Plan / Individual / Team Coding Plan）：
    // zcode.z.ai 试用网关要求桌面内嵌 WebView 滑块校验，Node 直连统一走官方账号铸 token 端点
    const endpoint=ACCOUNT_ENDPOINTS[access.accountType];
    if(!endpoint)throw Object.assign(new Error(`不支持的官方账号类型：${access.accountType}`),{reasonCode:"provider_family_unknown"});
    apiType="anthropic-messages";
    baseUrl=endpoint.anthropicBase;
    token=env.BZS_TITLE_TEST_TOKEN??await resolveAccountToken({access,credentialsPath,env,fetchImpl,now});
  } else {
    token=env.BZS_TITLE_TEST_TOKEN??access.apiKey;
  }

  const reasoningLevel=selection.options?.reasoningLevel;
  const thinkingActive=Boolean(reasoningLevel&&!["disabled","none","off","minimal"].includes(reasoningLevel));
  const requestedMax=thinkingActive?Math.max(maxOutputTokens,8192):maxOutputTokens;
  const modelMax=resolvedModel.config?.optionSpecs?.maxOutputTokens?.max;
  const effectiveMaxTokens=Number.isInteger(modelMax)&&modelMax>0?Math.min(requestedMax,modelMax):requestedMax;

  const systemText=messages.filter(m=>m.role==="system").map(m=>m.content).filter(Boolean).join("\n\n");
  const chatMessages=messages.filter(m=>m.role!=="system").map(m=>({role:m.role,content:m.content}));
  const attributionHeaders=isOpenRouterUrl(baseUrl)?{"X-OpenRouter-Title":"ZCode","X-OpenRouter-Categories":"programming-app"}:{};
  const customHeaders=resolvedProvider.config.api.headers??{};
  const optionSpecs=resolvedModel.config?.optionSpecs;

  let url,headers,body;
  if(apiType==="anthropic-messages") {
    url=`${normalizeAnthropicBaseUrl(baseUrl)}/messages`;
    headers=mergeHeaders(
      {"content-type":"application/json","anthropic-version":"2023-06-01","x-api-key":token,authorization:`Bearer ${token}`},
      attributionHeaders,
      customHeaders
    );
    const baseBody={model:selection.modelId,...(systemText?{system:systemText}:{}),messages:chatMessages};
    body=applyOptionSpecs(baseBody,optionSpecs,{reasoningLevel,maxOutputTokens:effectiveMaxTokens});
    if(body.max_tokens===undefined)body.max_tokens=effectiveMaxTokens;
  } else if(apiType==="openai-responses") {
    url=`${baseUrl.replace(/\/+$/u,"")}/responses`;
    headers=mergeHeaders(
      {"content-type":"application/json",authorization:`Bearer ${token}`},
      attributionHeaders,
      customHeaders
    );
    const baseBody={model:selection.modelId,...(systemText?{instructions:systemText}:{}),input:chatMessages};
    body=applyOptionSpecs(baseBody,optionSpecs,{reasoningLevel,maxOutputTokens:effectiveMaxTokens});
    if(body.max_output_tokens===undefined)body.max_output_tokens=effectiveMaxTokens;
  } else if(apiType==="openai-chat-completions") {
    url=`${baseUrl.replace(/\/+$/u,"")}/chat/completions`;
    headers=mergeHeaders(
      {"content-type":"application/json",authorization:`Bearer ${token}`},
      attributionHeaders,
      customHeaders
    );
    const baseBody={model:selection.modelId,messages:messages.map(m=>({role:m.role,content:m.content}))};
    body=applyOptionSpecs(baseBody,optionSpecs,{reasoningLevel,maxOutputTokens:effectiveMaxTokens});
    if(body.max_completion_tokens===undefined&&body.max_tokens===undefined)body.max_tokens=effectiveMaxTokens;
  } else {
    throw Object.assign(new Error(`不支持的渠道协议类型：${apiType}`),{reasonCode:"unsupported_api_type"});
  }

  let response;
  try {
    response=await fetchImpl(url,{
      method:"POST",
      headers,
      body:JSON.stringify(body),
      signal:AbortSignal.timeout(timeoutMs)
    });
  }catch(error) {
    throw Object.assign(new Error("模型请求失败："+error.message),{reasonCode:"model_request_failed",cause:error});
  }

  const rawText=await response.text();
  const contentType=(response.headers?.get?.("content-type")??"").toLowerCase();
  const isSse=contentType.includes("event-stream")||(!rawText.trim().startsWith("{")&&rawText.includes("data:"));
  let payload=null;
  if(!isSse) {
    try {payload=rawText?JSON.parse(rawText):null;}catch {payload=null;}
  }
  if(!response.ok||(!isSse&&!payload)) {
    throw Object.assign(new Error(`模型返回 HTTP ${response.status}：${rawText.slice(0,200)}`),{reasonCode:"model_http_error",httpStatus:response.status});
  }

  if(apiType==="anthropic-messages")return parseAnthropicResponse(payload,rawText,isSse);
  if(apiType==="openai-responses")return parseOpenAiResponses(payload,rawText,isSse);
  return parseOpenAiChatCompletions(payload,rawText,isSse);
}
