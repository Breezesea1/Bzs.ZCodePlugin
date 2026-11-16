// 配置加载与校验。外置 config.json 位于插件数据目录（${ZCODE_PLUGIN_DATA}/config.json），
// hook 与 CLI 共享；enabled:false 时 hook 静默跳过，首次安装按宿主目录自动初始化默认配置。
import {homedir} from "node:os";
import {join,resolve,dirname} from "node:path";
import {readJsonOptional} from "./fsutil.mjs";
import {loadHostCatalog} from "./hostcatalog.mjs";
import {randomUUID} from "node:crypto";
import {mkdir,readFile,writeFile,link,unlink} from "node:fs/promises";

const PROVIDER_ID_RE=/^[\w:@.-]{1,128}$/;
const MODEL_ID_RE=/^[\w:@.\/ -]{1,128}$/;
const REASONING_LEVEL_RE=/^[\w-]{1,32}$/;
const FAST_MODEL_RE=/(?:^|[\/_.-])(?:flash|mini|nano|lite|haiku|fast)(?:$|[\/_.-])/i;
const TURBO_MODEL_RE=/(?:^|[\/_.-])turbo(?:$|[\/_.-])/i;
const HEAVY_MODEL_RE=/reasoner|thinking|opus|ultra|explorer|(?:^|[\/_.-])r1(?:$|[\/_.-])/i;
const REASONING_PREFERENCE=["low","minimal","disabled","none","off","medium","enabled","high"];
const FALLBACK_SELECTION={
  providerId:"account:bigmodel-individual-coding-plan",
  modelId:"GLM-5.3-Flash",
  options:{reasoningLevel:"low"}
};

export const CONFIG_DEFAULTS={
  sessionDb:join(homedir(),".zcode","cli","db","db.sqlite"),
  indexDb:join(homedir(),".zcode","v2","tasks-index.sqlite"),
  titlePolicyDirectory:join(homedir(),".zcode","bzs-zcode-session-title","title-policies"),
  timeoutMs:120000,
  maxOutputTokens:2048,
  rename:{
    enabled:true,
    maxTitleChars:48,
    minTitleChars:6,
    requireFormat:true,
    maxTurns:6
  }
};

// configPath 的同级 dataDir：环境变量显式指定 > 配置字段 > 默认 state 子目录。
// hook（读 config 提取 dataDir）与 CLI（读合并后配置）共用同一解析规则。
export function resolveDataDir(configPath,supplied={},env=process.env) {
  return resolve(dirname(configPath),env.BZS_TITLE_DATA??supplied.dataDir??"state");
}

function resolveHomeDir(env=process.env) {
  return (process.platform==="win32"?env.USERPROFILE||env.HOME:env.HOME||env.USERPROFILE)||homedir();
}

function pickReasoningLevel(model) {
  const values=(model?.config?.optionSpecs?.reasoningLevel?.values??[]).filter(v=>typeof v==="string"&&REASONING_LEVEL_RE.test(v));
  if(!values.length)return "low";
  return REASONING_PREFERENCE.find(level=>values.includes(level))??values[0];
}

// 从宿主可用模型目录挑选默认总结模型：优先轻量高速模型，其次常规非重型推理模型。
export function pickDefaultSelection(catalog) {
  const providers=(catalog?.providers??[]).filter(p=>typeof p?.providerId==="string"&&PROVIDER_ID_RE.test(p.providerId));
  const candidates=[];
  for(const provider of providers) {
    for(const model of provider.models??[]) {
      if(typeof model?.modelId!=="string"||!MODEL_ID_RE.test(model.modelId))continue;
      const selection={providerId:provider.providerId,modelId:model.modelId,options:{reasoningLevel:pickReasoningLevel(model)}};
      if(validateSelection(selection,catalog)!==null)continue;
      const tier=FAST_MODEL_RE.test(model.modelId)?0
        :TURBO_MODEL_RE.test(model.modelId)?1
        :HEAVY_MODEL_RE.test(model.modelId)?3:2;
      candidates.push({tier,selection});
    }
  }
  if(!candidates.length)return null;
  candidates.sort((a,b)=>a.tier-b.tier);
  return candidates[0].selection;
}

export async function buildDefaultConfig({env=process.env}={}) {
  let matched=null;
  try {
    const catalog=await loadHostCatalog({env,homeDir:resolveHomeDir(env)});
    matched=pickDefaultSelection(catalog);
  }catch {}
  const {enabled:_r,...renameDefaults}=CONFIG_DEFAULTS.rename;
  return {
    selection:matched??structuredClone(FALLBACK_SELECTION),
    enabled:matched!==null,
    dataDir:"state",
    timeoutMs:CONFIG_DEFAULTS.timeoutMs,
    maxOutputTokens:CONFIG_DEFAULTS.maxOutputTokens,
    rename:renameDefaults
  };
}

// 硬链接原子发布完整文件，目标已存在则让位并回读，避免并发初始化互相覆盖。
async function publishConfigIfAbsent(configPath,supplied) {
  await mkdir(dirname(configPath),{recursive:true});
  const temporary=configPath+".tmp-"+randomUUID();
  try {
    await writeFile(temporary,JSON.stringify(supplied,null,2)+"\n","utf8");
    try {await link(temporary,configPath);}
    catch(error) {if(error.code!=="EEXIST")throw error;}
  } finally {await unlink(temporary).catch(()=>{});}
  return readJsonOptional(configPath);
}

function isPluginDataConfigPath(configPath,env=process.env) {
  return Boolean(env.ZCODE_PLUGIN_DATA&&resolve(configPath)===resolve(env.ZCODE_PLUGIN_DATA,"config.json"));
}

// 读取并在插件数据目录缺失 config.json 时自动迁移旧配置或生成默认配置。
// 显式传入的其他配置路径默认不继承或伪造配置（createDefault=true 除外）。
export async function ensureConfig(configPath,{env=process.env,createDefault=false}={}) {
  try {return {config:JSON.parse(await readFile(configPath,"utf8")),origin:"existing"};}
  catch(error) {if(error.code!=="ENOENT")throw error;}
  if(!isPluginDataConfigPath(configPath,env)&&!createDefault)return {config:null,origin:"missing"};
  const legacyPath=join(resolveHomeDir(env),".zcode","bzs-zcode-session-title","config.json");
  if(resolve(configPath)!==resolve(legacyPath)) {
    const legacy=await readJsonOptional(legacyPath);
    if(legacy!==null) {
      // 相对 dataDir（含默认 state）继续指向原目录，保留改名状态与日志。
      const supplied=typeof legacy==="object"&&!Array.isArray(legacy)
        ?{...legacy,dataDir:resolveDataDir(legacyPath,legacy,{})}:legacy;
      return {config:await publishConfigIfAbsent(configPath,supplied),origin:"migrated"};
    }
  }
  const defaults=await buildDefaultConfig({env});
  return {config:await publishConfigIfAbsent(configPath,defaults),origin:"initialized"};
}

export async function readConfig(configPath,{env=process.env}={}) {
  return (await ensureConfig(configPath,{env})).config;
}

// 管理命令（enable/status/lock 等）不依赖会话；run 命令必须完整配置。
export const SESSION_FREE_COMMANDS=["enable","disable","status","models","doctor","probe","policy","lock","unlock"];

export function validateSelection(selection,view) {
  if(!selection||typeof selection!=="object")return "selection 必须是对象";
  const {providerId,modelId}=selection;
  if(typeof providerId!=="string"||!PROVIDER_ID_RE.test(providerId))return "selection.providerId 无效";
  if(typeof modelId!=="string"||!MODEL_ID_RE.test(modelId))return "selection.modelId 无效";
  const options=selection.options??{};
  const level=options.reasoningLevel;
  if(typeof level!=="string"||!REASONING_LEVEL_RE.test(level))return "selection.options.reasoningLevel 无效";
  if(!view)return null;
  const provider=(view.providers??[]).find(p=>p.providerId===providerId);
  if(!provider)return `指定渠道不在宿主可用模型目录中：${providerId}`;
  const model=provider.models?.find(m=>m.modelId===modelId);
  if(!model)return `指定模型不在宿主可用模型目录中：${providerId}/${modelId}`;
  const values=model.config?.optionSpecs?.reasoningLevel?.values;
  if(Array.isArray(values)&&values.length>0&&!values.includes(level)) {
    return `指定思考档位不可用：${level}（支持：${values.join("/")}）`;
  }
  return null;
}

// 校验并合并配置；错误返回 {error}，成功返回完整配置。
// allowDisabled：管理命令需要读配置改开关，不把 enabled:false 当错误。
export async function loadConfig(configPath,{env=process.env,allowDisabled=false}={}) {
  let supplied={};
  try {
    const parsed=await readConfig(configPath,{env});
    if(parsed===null)return {error:"not_configured",message:"配置文件不存在："+configPath};
    supplied=parsed;
  } catch(error) {
    if(error instanceof SyntaxError)return {error:"invalid_config",message:"配置文件 JSON 无效："+configPath};
    throw error;
  }
  if(typeof supplied!=="object"||supplied===null||Array.isArray(supplied))return {error:"invalid_config",message:"配置必须是 JSON 对象"};
  if(supplied.enabled===false&&!allowDisabled)return {error:"disabled",message:"自动命名已暂停"};
  // 旧配置兼容：丢弃已移除的 sqliteBin、gateway、model（host-follow）字段
  const {sqliteBin:_d1,gateway:_d2,model:_d3,...merged}=supplied;
  const config={
    ...CONFIG_DEFAULTS,
    ...merged,
    rename:{...CONFIG_DEFAULTS.rename,...(supplied.rename??"")}
  };
  if(!config.selection)return {error:"selection_invalid",message:"必须配置 selection"};
  const selectionError=validateSelection(config.selection);
  if(selectionError)return {error:"selection_invalid",message:selectionError};
  if(!Number.isInteger(config.timeoutMs)||config.timeoutMs<1000||config.timeoutMs>300000)return {error:"invalid_config",message:"timeoutMs 应在 1000–300000 范围内"};
  if(!Number.isInteger(config.maxOutputTokens)||config.maxOutputTokens<256||config.maxOutputTokens>16384)return {error:"invalid_config",message:"maxOutputTokens 应在 256–16384 范围内"};
  if(config.rename.maxTitleChars<10||config.rename.maxTitleChars>96)return {error:"invalid_config",message:"rename.maxTitleChars 应在 10–96 范围内"};
  if(config.rename.minTitleChars<3||config.rename.minTitleChars>=config.rename.maxTitleChars)return {error:"invalid_config",message:"rename.minTitleChars 应小于 maxTitleChars"};
  if(!Number.isInteger(config.rename.maxTurns)||config.rename.maxTurns<1||config.rename.maxTurns>20)return {error:"invalid_config",message:"rename.maxTurns 应在 1–20 范围内"};
  return {config};
}
