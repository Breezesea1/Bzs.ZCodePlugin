// 宿主 ZCode 模型目录与配置规则解析器。
// 直接读取宿主本地的 zcode-builtin.json、provider_config.json 与 credentials.json，
// 按宿主 ProviderConfigResolver / ModelConfigRules 同构规则还原所有已启用渠道、可用模型、
// 支持的思考档位及请求体映射表达式（Restricted CEL），零常驻、零网关。
import {createDecipheriv,createHash} from "node:crypto";
import {existsSync,readdirSync,readFileSync,statSync} from "node:fs";
import {readFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {homedir,platform,userInfo} from "node:os";
import {dirname,join,resolve} from "node:path";
import {readJsonOptional} from "./fsutil.mjs";

const requireAddon=createRequire(import.meta.url);
const KEYRING_SERVICE="ZCode Credential Encryption";
let cachedKeyringAddon;

function loadHostKeyringAddon(env=process.env,homeDir=homedir()) {
  if(cachedKeyringAddon!==undefined)return cachedKeyringAddon;
  const dirs=[];
  if(env.ZCODE_WINDOWS_APP_INSTALL_DIR?.trim()) {
    dirs.push(join(env.ZCODE_WINDOWS_APP_INSTALL_DIR.trim(),"resources","app.asar.unpacked","node_modules","@napi-rs"));
  }
  const localAppData=env.LOCALAPPDATA||join(homeDir,"AppData","Local");
  dirs.push(
    join(localAppData,"Programs","ZCode","resources","app.asar.unpacked","node_modules","@napi-rs"),
    "/Applications/ZCode.app/Contents/Resources/app.asar.unpacked/node_modules/@napi-rs",
    "/opt/ZCode/resources/app.asar.unpacked/node_modules/@napi-rs"
  );
  for(const base of dirs) {
    if(!existsSync(base))continue;
    try {
      for(const sub of readdirSync(base)) {
        if(!sub.startsWith("keyring-"))continue;
        const subDir=join(base,sub);
        const nodeFile=readdirSync(subDir).find(f=>f.endsWith(".node"));
        if(nodeFile) {
          cachedKeyringAddon=requireAddon(join(subDir,nodeFile));
          return cachedKeyringAddon;
        }
      }
    }catch {}
  }
  cachedKeyringAddon=null;
  return null;
}

function openGcmEnvelope(envelope,key) {
  const parts=envelope.split(".");
  if(parts.length!==3||parts.some(p=>!p||!/^[A-Za-z0-9_-]+$/.test(p))) {
    throw Object.assign(new Error("凭据密文格式无效"),{reasonCode:"credentials_invalid"});
  }
  const [iv,tag,data]=parts.map(p=>Buffer.from(p,"base64url"));
  if(iv.length!==12||tag.length!==16) {
    throw Object.assign(new Error("凭据密文格式无效"),{reasonCode:"credentials_invalid"});
  }
  try {
    const decipher=createDecipheriv("aes-256-gcm",key,iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data),decipher.final()]).toString("utf8").trim();
  }catch {
    throw Object.assign(new Error("凭据解密失败：密钥或密文不匹配"),{reasonCode:"credentials_decrypt_failed"});
  }
}

function resolveManagedSecretSync(credentialsPath,env=process.env) {
  if(env.ZCODE_CREDENTIAL_SECRET&&env.ZCODE_CREDENTIAL_SECRET_FILE) {
    throw Object.assign(new Error("ZCODE_CREDENTIAL_SECRET 与 ZCODE_CREDENTIAL_SECRET_FILE 不能同时配置"),{reasonCode:"credentials_decrypt_failed"});
  }
  if(env.ZCODE_CREDENTIAL_SECRET)return env.ZCODE_CREDENTIAL_SECRET;
  const secretFile=env.ZCODE_CREDENTIAL_SECRET_FILE||(credentialsPath?join(dirname(resolve(credentialsPath)),"credential-secret"):null);
  if(!secretFile||!existsSync(secretFile))return null;
  try {
    const content=readFileSync(secretFile,"utf8");
    const len=Buffer.byteLength(content,"utf8");
    return len>=32&&len<=4096?content:null;
  }catch {return null;}
}

function keyFingerprint(key) {
  return createHash("sha256").update(key).digest("hex").slice(0,24);
}

const SUPPORTED_API_TYPES=new Set(["anthropic-messages","openai-chat-completions","openai-responses"]);
const SELECTABLE_ACCOUNT_MODES=new Set(["start-plan","individual-coding-plan","team-coding-plan"]);

const DEFAULT_API_OPTION_SPECS={
  "anthropic-messages":{
    reasoningMap:`reasoningLevel == "disabled" ? {"thinking":{"type":"disabled"}} : {"thinking":{"type":"adaptive"},"output_config":{"effort":reasoningLevel == "enabled" ? "high" : reasoningLevel}}`,
    maxTokensMap:`{"max_tokens": maxOutputTokens}`
  },
  "openai-chat-completions":{
    reasoningMap:`{"thinking":{"type":reasoningLevel == "disabled" || reasoningLevel == "none" ? "disabled" : "enabled"},"enable_thinking":reasoningLevel != "disabled" && reasoningLevel != "none","reasoning_effort":reasoningLevel == "disabled" ? "none" : reasoningLevel == "enabled" ? "high" : reasoningLevel,"reasoning":{"effort":reasoningLevel == "disabled" ? "none" : reasoningLevel == "enabled" ? "high" : reasoningLevel}}`,
    maxTokensMap:`{"max_completion_tokens": maxOutputTokens}`
  },
  "openai-responses":{
    reasoningMap:`{"reasoning":{"effort":reasoningLevel == "disabled" ? "none" : reasoningLevel == "enabled" ? "high" : reasoningLevel}}`,
    maxTokensMap:`{"max_output_tokens": maxOutputTokens}`
  }
};

export function credentialSecret(env=process.env) {
  const explicit=env.ZCODE_CREDENTIAL_SECRET;
  if(explicit)return explicit;
  let user="unknown";
  try {user=userInfo().username;}catch {}
  return `zcode-credential-fallback:${platform()}:${homedir()}:${user}`;
}

export function decryptCredentialValue(stored,env=process.env,{credentialsPath=null,homeDir=homedir(),osKeyReader=null}={}) {
  if(typeof stored!=="string"||!stored)return null;
  if(stored.startsWith("enc:v1:")) {
    const envelope=stored.slice(7);
    const managed=resolveManagedSecretSync(credentialsPath,env);
    const fallback=credentialSecret(env);
    const secrets=[...new Set([managed,managed?.trim(),fallback].filter(Boolean))];
    let lastError=null;
    for(const secret of secrets) {
      try {
        const key=createHash("sha256").update(secret).digest();
        return openGcmEnvelope(envelope,key)||null;
      }catch(error) {lastError=error;}
    }
    throw lastError??Object.assign(new Error("凭据解密失败：密钥或密文不匹配"),{reasonCode:"credentials_decrypt_failed"});
  }
  if(stored.startsWith("enc:v2:")) {
    const segments=stored.slice(7).split(":");
    if(segments.length!==3||!["os","env"].includes(segments[0])||!/^[a-f0-9]{24}$/.test(segments[1])||!segments[2]) {
      throw Object.assign(new Error("凭据密文格式无效"),{reasonCode:"credentials_invalid"});
    }
    const [source,expectedFp,envelope]=segments;
    let key;
    if(source==="env") {
      const secret=resolveManagedSecretSync(credentialsPath,env);
      if(!secret)throw Object.assign(new Error("凭据解密失败：未找到受管密钥"),{reasonCode:"credentials_decrypt_failed"});
      key=createHash("sha256").update(secret).digest();
    } else {
      const resolvedCredsPath=resolve(credentialsPath??join(homeDir,".zcode","v2","credentials.json"));
      const account=createHash("sha256").update(resolvedCredsPath).digest("hex");
      let encodedKey=null;
      try {
        if(osKeyReader) {
          encodedKey=osKeyReader(KEYRING_SERVICE,account);
        } else {
          const addon=loadHostKeyringAddon(env,homeDir);
          if(!addon?.Entry)throw new Error("missing keyring addon");
          const entry=platform()==="linux"
            ?new addon.Entry(KEYRING_SERVICE,account,{linux:{store:"secret-service"}})
            :new addon.Entry(KEYRING_SERVICE,account);
          encodedKey=entry.getPassword();
        }
      }catch {
        throw Object.assign(new Error("凭据解密失败：无法读取系统凭据库主密钥"),{reasonCode:"credentials_decrypt_failed"});
      }
      if(typeof encodedKey!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(encodedKey)) {
        throw Object.assign(new Error("凭据解密失败：系统凭据库主密钥缺失或格式无效"),{reasonCode:"credentials_decrypt_failed"});
      }
      key=Buffer.from(encodedKey,"base64url");
    }
    if(key.length!==32||keyFingerprint(key)!==expectedFp) {
      throw Object.assign(new Error("凭据解密失败：主密钥指纹不匹配"),{reasonCode:"credentials_decrypt_failed"});
    }
    return openGcmEnvelope(envelope,key)||null;
  }
  if(stored.startsWith("enc:")) {
    throw Object.assign(new Error("不支持的凭据密文版本"),{reasonCode:"credentials_invalid"});
  }
  return stored.trim()||null;
}

export async function readCredentials(credentialsPath,env=process.env) {
  let raw;
  try {raw=await readFile(credentialsPath,"utf8");}
  catch(error) {
    if(error.code==="ENOENT")return null;
    throw error;
  }
  try {return JSON.parse(raw);}
  catch {throw Object.assign(new Error("凭据文件 JSON 无效"),{reasonCode:"credentials_invalid"});}
}

function findRuntimeBuiltinFiles(dir,depth=0,found=[]) {
  if(depth>4||!existsSync(dir))return found;
  let entries;
  try {entries=readdirSync(dir,{withFileTypes:true});}catch {return found;}
  for(const entry of entries) {
    const full=join(dir,entry.name);
    if(entry.isDirectory())findRuntimeBuiltinFiles(full,depth+1,found);
    else if(entry.isFile()&&entry.name==="zcode-builtin.json") {
      let mtimeMs=0;
      try {mtimeMs=statSync(full).mtimeMs;}catch {}
      found.push({path:full,mtimeMs});
    }
  }
  return found;
}

export async function loadBuiltinRelease({v2Dir,env=process.env,homeDir=homedir()}) {
  const candidates=[];
  const explicit=env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE?.trim();
  if(explicit)candidates.push(resolve(explicit));
  const runtimeFound=findRuntimeBuiltinFiles(join(v2Dir,"runtime","provider"))
    .sort((a,b)=>b.mtimeMs-a.mtimeMs)
    .map(item=>item.path);
  candidates.push(...runtimeFound);
  // 显式指定 BZS_TITLE_ZCODE_V2_DIR（如隔离单测）时，不跨目录回退到宿主安装目录
  if(!env.BZS_TITLE_ZCODE_V2_DIR) {
    if(env.ZCODE_WINDOWS_APP_INSTALL_DIR?.trim()) {
      candidates.push(join(env.ZCODE_WINDOWS_APP_INSTALL_DIR.trim(),"resources","config","provider","zcode-builtin.json"));
    }
    const localAppData=env.LOCALAPPDATA||join(homeDir,"AppData","Local");
    candidates.push(
      join(localAppData,"Programs","ZCode","resources","config","provider","zcode-builtin.json"),
      "/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json",
      "/opt/ZCode/resources/config/provider/zcode-builtin.json"
    );
  }
  let best=null;
  for(const filePath of candidates) {
    if(!existsSync(filePath))continue;
    try {
      const parsed=await readJsonOptional(filePath);
      if(!parsed?.config?.providerConfigRules)continue;
      if(!best||(parsed.revision??0)>(best.revision??0))best=parsed;
    }catch {}
  }
  return best;
}

function uniqueInOrder(items=[]) {
  const seen=new Set();
  return items.filter(item=>typeof item==="string"&&item.trim()&&!seen.has(item)&&(seen.add(item),true));
}

function normalizeModelOrder(builtinIds=[],personalIds=[],order=[]) {
  const builtin=uniqueInOrder(builtinIds);
  const builtinSet=new Set(builtin);
  const personal=uniqueInOrder(personalIds).filter(id=>!builtinSet.has(id));
  const allSet=new Set([...builtin,...personal]);
  const ordered=uniqueInOrder(order).filter(id=>allSet.has(id));
  const orderedSet=new Set(ordered);
  return [
    ...ordered,
    ...builtin.filter(id=>!orderedSet.has(id)),
    ...personal.filter(id=>!orderedSet.has(id))
  ];
}

function normalizeBaseUrlForMatch(baseUrl) {
  try {
    const u=new URL(baseUrl);
    const tail=`${u.search}${u.hash}`;
    const full=u.toString();
    return `${(tail.length===0?full:full.slice(0,-tail.length)).replace(/\/+$/,"")}${tail}`;
  }catch {
    return undefined;
  }
}

function fullMatch(pattern,value,caseInsensitive=false) {
  if(typeof pattern!=="string"||typeof value!=="string")return false;
  try {return new RegExp(`^(?:${pattern})$`,caseInsensitive?"i":undefined).test(value);}
  catch {return false;}
}

function overlayProviderConfig(base={},patch={}) {
  const access=patch.access===undefined?base.access:(patch.access===null||!base.access||base.access.type!==patch.access.type?patch.access:{...base.access,...patch.access});
  const api=patch.api===undefined?base.api:(patch.api===null||!base.api?patch.api:{...base.api,...patch.api});
  return {
    ...base,
    ...Object.fromEntries(Object.entries(patch).filter(([,v])=>v!==undefined)),
    ...(access!==undefined?{access}:{}),
    ...(api!==undefined?{api}:{})
  };
}

function overlayModelConfig(base={},patch={},isManual=false) {
  // manual-provider-model 重置可编辑属性，但保留底层协议的 optionSpecs.map（若手动配置未显式覆盖）
  const seed=isManual?{
    enabled:base.enabled,
    optionSpecs:{
      reasoningLevel:base.optionSpecs?.reasoningLevel?.map?{map:base.optionSpecs.reasoningLevel.map}:{},
      maxOutputTokens:base.optionSpecs?.maxOutputTokens?.map?{map:base.optionSpecs.maxOutputTokens.map}:{}
    }
  }:base;
  const baseProps=seed.properties??{};
  const patchProps=patch.properties??{};
  const baseSpecs=seed.optionSpecs??{};
  const patchSpecs=patch.optionSpecs??{};
  return {
    enabled:patch.enabled!==undefined?patch.enabled:seed.enabled,
    properties:{
      ...baseProps,
      ...patchProps,
      ...(baseProps.inputFormat||patchProps.inputFormat?{inputFormat:{...baseProps.inputFormat,...patchProps.inputFormat}}:{})
    },
    optionSpecs:{
      reasoningLevel:{
        ...baseSpecs.reasoningLevel,
        ...Object.fromEntries(Object.entries(patchSpecs.reasoningLevel??{}).filter(([,v])=>v!==undefined&&v!==null))
      },
      maxOutputTokens:{
        ...baseSpecs.maxOutputTokens,
        ...Object.fromEntries(Object.entries(patchSpecs.maxOutputTokens??{}).filter(([,v])=>v!==undefined&&v!==null))
      }
    }
  };
}

function resolveModelConfig({providerId,templateId,modelId,apiType,baseUrl,builtinRules,personalRules}) {
  const defaults=DEFAULT_API_OPTION_SPECS[apiType]??DEFAULT_API_OPTION_SPECS["openai-chat-completions"];
  let resolved={
    enabled:true,
    properties:{contextWindow:1000000},
    optionSpecs:{
      reasoningLevel:{values:["disabled","enabled"],map:defaults.reasoningMap},
      maxOutputTokens:{max:128000,map:defaults.maxTokensMap}
    }
  };
  const normalizedUrl=baseUrl?normalizeBaseUrlForMatch(baseUrl):undefined;
  for(const rule of builtinRules?.modelRules??[]) {
    if(fullMatch(rule.modelMatch,modelId,true))resolved=overlayModelConfig(resolved,rule.config);
  }
  for(const rule of builtinRules?.modelApiRules??[]) {
    if(!fullMatch(rule.modelMatch,modelId,true))continue;
    if(rule.apiTypeMatch!==undefined&&!fullMatch(rule.apiTypeMatch,apiType))continue;
    resolved=overlayModelConfig(resolved,rule.config);
  }
  for(const rule of builtinRules?.providerSiteRules??[]) {
    if(!fullMatch(rule.modelMatch,modelId,true))continue;
    if(rule.apiTypeMatch!==undefined&&!fullMatch(rule.apiTypeMatch,apiType))continue;
    if(!normalizedUrl||!fullMatch(rule.baseUrlMatch,normalizedUrl))continue;
    resolved=overlayModelConfig(resolved,rule.config);
  }
  for(const rule of builtinRules?.templateModelRules??[]) {
    if(rule.templateId===templateId&&rule.modelId===modelId)resolved=overlayModelConfig(resolved,rule.config);
  }
  for(const rule of builtinRules?.builtinProviderModelRules??[]) {
    if(rule.providerId===providerId&&rule.modelId===modelId)resolved=overlayModelConfig(resolved,rule.config);
  }
  for(const rule of personalRules?.providerModelRules??[]) {
    if(rule.providerId===providerId&&rule.modelId===modelId)resolved=overlayModelConfig(resolved,rule.config);
  }
  for(const rule of personalRules?.manualProviderModelRules??[]) {
    if(rule.providerId===providerId&&rule.modelId===modelId)resolved=overlayModelConfig(resolved,rule.config,true);
  }
  if(!Array.isArray(resolved.optionSpecs?.reasoningLevel?.values)||resolved.optionSpecs.reasoningLevel.values.length===0) {
    resolved.optionSpecs.reasoningLevel.values=["disabled","enabled"];
  }
  if(!resolved.optionSpecs.reasoningLevel.map)resolved.optionSpecs.reasoningLevel.map=defaults.reasoningMap;
  if(!resolved.optionSpecs.maxOutputTokens.map)resolved.optionSpecs.maxOutputTokens.map=defaults.maxTokensMap;
  return resolved;
}

function legacyKindToApiType(kind) {
  if(kind==="anthropic")return "anthropic-messages";
  if(kind==="openai")return "openai-responses";
  return "openai-chat-completions";
}

function importLegacyPersonalConfig(legacy) {
  const providerRules=[];
  const providerModelRules=[];
  for(const [id,entry] of Object.entries(legacy?.provider??{})) {
    const providerId=id.trim();
    if(!providerId||providerId.startsWith("builtin:")||providerId.startsWith("account:"))continue;
    if(entry.source!==undefined&&entry.source!=="custom")continue;
    const baseUrl=entry.options?.baseURL?.trim();
    const apiKey=entry.options?.apiKey?.trim();
    if(!baseUrl||!apiKey)continue;
    const modelIds=Object.keys(entry.models??{});
    providerRules.push({
      providerId,
      providerName:entry.name??providerId,
      enabled:entry.enabled!==false,
      config:{
        group:"standard-personal",
        access:{type:"api-key",apiKey},
        api:{type:entry.apiFormat&&SUPPORTED_API_TYPES.has(entry.apiFormat)?entry.apiFormat:legacyKindToApiType(entry.kind),baseUrl},
        personalModelIds:modelIds,
        modelOrder:modelIds
      }
    });
    for(const [modelId,model] of Object.entries(entry.models??{})) {
      const levels=model?.reasoning?.levels??model?.reasoning?.variants;
      if(Array.isArray(levels)&&levels.length>0) {
        providerModelRules.push({
          providerId,modelId,
          config:{optionSpecs:{reasoningLevel:{values:levels}}}
        });
      }
    }
  }
  return {providerConfigRules:{providerRules},modelConfigRules:{providerModelRules,manualProviderModelRules:[]}};
}

// 读取并解析宿主 ZCode 当前完整可用模型目录。
export async function loadHostCatalog({env=process.env,homeDir=homedir()}={}) {
  const v2Dir=env.BZS_TITLE_ZCODE_V2_DIR?resolve(env.BZS_TITLE_ZCODE_V2_DIR):join(homeDir,".zcode","v2");
  const personalPath=env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim()
    ?resolve(env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE.trim())
    :join(v2Dir,"provider_config.json");
  const credentialsPath=env.BZS_TITLE_CREDENTIALS?.trim()
    ?resolve(env.BZS_TITLE_CREDENTIALS.trim())
    :join(v2Dir,"credentials.json");

  const [builtinRelease,personalFile,credentials,setting]=await Promise.all([
    loadBuiltinRelease({v2Dir,env,homeDir}),
    readJsonOptional(personalPath).catch(()=>null),
    readCredentials(credentialsPath,env).catch(()=>null),
    readJsonOptional(join(v2Dir,"setting.json")).catch(()=>null)
  ]);

  let personalConfig=personalFile?.config??null;
  if(!personalConfig) {
    const legacy=await readJsonOptional(join(v2Dir,"config.json")).catch(()=>null);
    if(legacy?.provider)personalConfig=importLegacyPersonalConfig(legacy);
  }

  const templates=new Map();
  for(const tpl of builtinRelease?.config?.providerConfigRules?.templateRules??[]) {
    templates.set(tpl.templateId,tpl);
  }
  const builtinProviders=new Map();
  for(const rule of builtinRelease?.config?.providerConfigRules?.providerRules??[]) {
    const tplConfig=rule.templateId?templates.get(rule.templateId)?.config:undefined;
    builtinProviders.set(rule.providerId,{
      ...rule,
      config:tplConfig?overlayProviderConfig(tplConfig,rule.config):rule.config
    });
  }

  // 检测已登录的官方账号家族（bigmodel / zai）
  const entitledFamilies=new Set();
  if(credentials) {
    for(const [family,key] of [["bigmodel","oauth:bigmodel:access_token"],["zai","oauth:zai:access_token"]]) {
      try {
        if(decryptCredentialValue(credentials[key],env,{credentialsPath,homeDir}))entitledFamilies.add(family);
      }catch {}
    }
  }

  const mergedRules=new Map(builtinProviders);
  for(const rule of personalConfig?.providerConfigRules?.providerRules??[]) {
    const existing=mergedRules.get(rule.providerId);
    if(existing) {
      mergedRules.set(rule.providerId,{
        providerId:rule.providerId,
        templateId:rule.templateId??existing.templateId,
        providerName:rule.providerName??existing.providerName,
        enabled:rule.enabled??existing.enabled,
        config:overlayProviderConfig(existing.config,rule.config)
      });
    } else {
      const tpl=rule.templateId?templates.get(rule.templateId):undefined;
      const defaultName=tpl?.templateNameMap?.["zh-CN"]??tpl?.templateNameMap?.["en-US"]??rule.providerId;
      mergedRules.set(rule.providerId,{
        providerId:rule.providerId,
        templateId:rule.templateId,
        providerName:rule.providerName??defaultName,
        enabled:rule.enabled??true,
        config:tpl?.config?overlayProviderConfig(tpl.config,rule.config):rule.config
      });
    }
  }

  // Provider 排序：官方账号渠道在前，个人渠道按 providerOrder 排列
  const accountIds=[...mergedRules.keys()].filter(id=>{
    const group=mergedRules.get(id)?.config?.group;
    return group==="zai-family"||group==="bigmodel-family";
  });
  const accountSet=new Set(accountIds);
  const otherIds=[...mergedRules.keys()].filter(id=>!accountSet.has(id));
  const orderedOther=normalizeModelOrder([],otherIds,personalConfig?.providerOrder??[]);
  const providerOrder=[...accountIds,...orderedOther];

  const builtinModelRules=builtinRelease?.config?.modelConfigRules;
  const personalModelRules=personalConfig?.modelConfigRules;
  const providers=[];

  for(const providerId of providerOrder) {
    const rule=mergedRules.get(providerId);
    const cfg=rule?.config;
    if(!cfg||cfg.visibility==="hidden")continue;
    const apiType=cfg.api?.type;
    const baseUrl=cfg.api?.baseUrl?.trim();
    if(!SUPPORTED_API_TYPES.has(apiType)||!baseUrl)continue;

    let teamLocation=null;
    let resolvedApiKey=null;
    if(cfg.access?.type==="zhipu-account") {
      if(!SELECTABLE_ACCOUNT_MODES.has(cfg.access.mode))continue;
      if(!entitledFamilies.has(cfg.access.accountType))continue;
      if(cfg.access.mode==="team-coding-plan") {
        const conn=setting?.providerFamilyConnectionSelections?.[cfg.access.accountType];
        if(conn?.kind!=="team-coding-plan"||!conn.organizationId||!conn.projectId)continue;
        teamLocation={organizationId:conn.organizationId,projectId:conn.projectId};
      }
    } else {
      if(rule.enabled===false)continue;
      const apiKey=cfg.access?.apiKey;
      if(typeof apiKey!=="string"||!apiKey.trim())continue;
      try {resolvedApiKey=decryptCredentialValue(apiKey,env,{credentialsPath,homeDir});}catch {resolvedApiKey=null;}
      if(!resolvedApiKey)continue;
    }

    const modelIds=normalizeModelOrder(cfg.builtinModelIds??[],cfg.personalModelIds??[],cfg.modelOrder??[]);
    const models=[];
    for(const modelId of modelIds) {
      const modelConfig=resolveModelConfig({
        providerId,
        templateId:rule.templateId,
        modelId,
        apiType,
        baseUrl,
        builtinRules:builtinModelRules,
        personalRules:personalModelRules
      });
      if(modelConfig.enabled===false)continue;
      models.push({modelId,config:modelConfig});
    }
    if(models.length===0)continue;
    providers.push({
      providerId,
      providerName:rule.providerName??providerId,
      ...(rule.templateId?{templateId:rule.templateId}:{}),
      config:{
        api:{type:apiType,baseUrl,...(cfg.api?.headers?{headers:cfg.api.headers}:{})},
        access:cfg.access?.type==="zhipu-account"
          ?{type:"zhipu-account",accountType:cfg.access.accountType,mode:cfg.access.mode,...(teamLocation?{teamLocation}:{})}
          :{type:cfg.access.type??"api-key",apiKey:resolvedApiKey}
      },
      models
    });
  }

  return {providers};
}

// ---------------- Restricted CEL 表达式求值（与宿主 compileModelOptionMaps 同构，无 eval） ----------------

const TWO_CHAR_OPS=new Set(["&&","||","==","!=","<=",">="]);
const ONE_CHAR_OPS=new Set(["+","-","*","/","%","!","<",">"]);
const PUNCT=new Set(["{","}","[","]","(",")",",",":","?","."]);
const ESCAPES={"'":"'",'"':'"',"\\":"\\",b:"\b",f:"\f",n:"\n",r:"\r",t:"\t"};

function tokenizeCel(src) {
  const tokens=[];
  let i=0;
  while(i<src.length) {
    const ch=src[i];
    if(/\s/u.test(ch)){i++;continue;}
    if(ch==="'"||ch==='"') {
      const quote=ch;
      let j=i+1,val="";
      while(j<src.length&&src[j]!==quote) {
        if(src[j]==="\\") {
          j++;
          const esc=src[j];
          if(esc==="u") {
            const hex=src.slice(j+1,j+5);
            if(!/^[0-9A-Fa-f]{4}$/.test(hex))throw new Error("无效 unicode 转义");
            val+=String.fromCharCode(Number.parseInt(hex,16));
            j+=5;
          } else if(ESCAPES[esc]!==undefined) {
            val+=ESCAPES[esc];j++;
          } else throw new Error(`不支持转义 \\${esc}`);
        } else {val+=src[j++];}
      }
      if(src[j]!==quote)throw new Error("未闭合字符串字面量");
      tokens.push({kind:"string",value:val});
      i=j+1;
      continue;
    }
    if(/[0-9]/.test(ch)) {
      const m=/^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      if(!m)throw new Error("无效数字字面量");
      tokens.push({kind:"number",value:Number(m[0])});
      i+=m[0].length;
      continue;
    }
    if(/[A-Za-z_]/.test(ch)) {
      let j=i+1;
      while(j<src.length&&/[A-Za-z0-9_]/.test(src[j]))j++;
      tokens.push({kind:"identifier",value:src.slice(i,j)});
      i=j;
      continue;
    }
    const two=src.slice(i,i+2);
    if(TWO_CHAR_OPS.has(two)){tokens.push({kind:"op",value:two});i+=2;continue;}
    if(ONE_CHAR_OPS.has(ch)){tokens.push({kind:"op",value:ch});i++;continue;}
    if(PUNCT.has(ch)){tokens.push({kind:"punct",value:ch});i++;continue;}
    throw new Error(`不支持的表达式符号：${ch}`);
  }
  tokens.push({kind:"eof",value:""});
  return tokens;
}

export function evaluateOptionMap(source,variableName,inputValue) {
  const trimmed=String(source??"").trim();
  if(!trimmed)return {};
  const tokens=tokenizeCel(trimmed);
  let pos=0;
  const cur=()=>tokens[pos]??tokens[tokens.length-1];
  const eat=val=>cur().value===val?(pos++,true):false;
  const expect=val=>{if(!eat(val))throw new Error(`表达式期望 ${val}，实际 ${cur().value}`);};

  function parseCond() {
    const cond=parseOr();
    if(!eat("?"))return cond;
    const tBranch=parseCond();
    expect(":");
    const fBranch=parseCond();
    return ()=> (cond()?tBranch():fBranch());
  }
  function parseOr() {
    let left=parseAnd();
    while(eat("||")){const r=parseAnd(),l=left;left=()=>Boolean(l()||r());}
    return left;
  }
  function parseAnd() {
    let left=parseEq();
    while(eat("&&")){const r=parseEq(),l=left;left=()=>Boolean(l()&&r());}
    return left;
  }
  function parseEq() {
    let left=parseRel();
    while(cur().kind==="op"&&(cur().value==="=="||cur().value==="!=")) {
      const op=tokens[pos++].value,r=parseRel(),l=left;
      left=op==="=="?()=>l()===r():()=>l()!==r();
    }
    return left;
  }
  function parseRel() {
    let left=parseAdd();
    while(cur().kind==="op"&&["<","<=",">",">="].includes(cur().value)) {
      const op=tokens[pos++].value,r=parseAdd(),l=left;
      left=()=>{const a=l(),b=r();return op==="<"?a<b:op==="<="?a<=b:op===">"?a>b:a>=b;};
    }
    return left;
  }
  function parseAdd() {
    let left=parseUnary();
    while(cur().kind==="op"&&(cur().value==="+"||cur().value==="-")) {
      const op=tokens[pos++].value,r=parseUnary(),l=left;
      left=op==="+"?()=>l()+r():()=>l()-r();
    }
    return left;
  }
  function parseUnary() {
    if(cur().kind==="op"&&(cur().value==="!"||cur().value==="-")) {
      const op=tokens[pos++].value,sub=parseUnary();
      return op==="!"?()=>!sub():()=>-sub();
    }
    return parsePrimary();
  }
  function parsePrimary() {
    const t=cur();
    if(t.kind==="string"||t.kind==="number"){pos++;return ()=>t.value;}
    if(t.kind==="identifier") {
      pos++;
      if(t.value===variableName)return ()=>inputValue;
      if(t.value==="true")return ()=>true;
      if(t.value==="false")return ()=>false;
      if(t.value==="null")return ()=>null;
      throw new Error(`未知标识符：${t.value}`);
    }
    if(eat("(")){const inner=parseCond();expect(")");return inner;}
    if(eat("[")) {
      const items=[];
      if(!eat("]")){do items.push(parseCond());while(eat(","));expect("]");}
      return ()=>items.map(fn=>fn());
    }
    if(eat("{")) {
      const entries=[];
      if(!eat("}")) {
        do {
          const keyTok=cur();
          if(keyTok.kind!=="string")throw new Error("对象键必须是字符串字面量");
          pos++;
          expect(":");
          entries.push([keyTok.value,parseCond()]);
        } while(eat(","));
        expect("}");
      }
      return ()=>{
        const out={};
        for(const [k,fn] of entries)out[k]=fn();
        return out;
      };
    }
    throw new Error(`表达式语法错误：${t.value}`);
  }

  const root=parseCond();
  if(cur().kind!=="eof")throw new Error(`表达式尾部多余内容：${cur().value}`);
  const evaluated=root();
  if(!evaluated||typeof evaluated!=="object"||Array.isArray(evaluated)) {
    throw new Error("optionSpecs.map 必须求值为 JSON 对象");
  }
  return evaluated;
}

function mergeJsonPatch(target,patch) {
  const out={...target};
  for(const [k,v] of Object.entries(patch??{})) {
    if(v===null){delete out[k];continue;}
    if(v&&typeof v==="object"&&!Array.isArray(v)&&out[k]&&typeof out[k]==="object"&&!Array.isArray(out[k])) {
      out[k]=mergeJsonPatch(out[k],v);
    } else {
      out[k]=v;
    }
  }
  return out;
}

export function applyOptionSpecs(baseBody,optionSpecs,{reasoningLevel,maxOutputTokens}) {
  let out={...baseBody};
  if(optionSpecs?.reasoningLevel?.map&&reasoningLevel!==undefined) {
    out=mergeJsonPatch(out,evaluateOptionMap(optionSpecs.reasoningLevel.map,"reasoningLevel",reasoningLevel));
  }
  if(optionSpecs?.maxOutputTokens?.map&&maxOutputTokens!==undefined) {
    out=mergeJsonPatch(out,evaluateOptionMap(optionSpecs.maxOutputTokens.map,"maxOutputTokens",maxOutputTokens));
  }
  return out;
}
