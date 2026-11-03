// 配置加载与校验。外置 config.json 位于插件数据目录（${ZCODE_PLUGIN_DATA}/config.json），
// hook 与 CLI 共享；enabled:false 时 hook 静默跳过，首次配置保持暂停待用户选模型。
import {homedir} from "node:os";
import {join,resolve,dirname} from "node:path";
import {readJsonOptional} from "./fsutil.mjs";

const PROVIDER_ID_RE=/^[\w:@.-]{1,128}$/;
const MODEL_ID_RE=/^[\w:@.\/ -]{1,128}$/;
const REASONING_LEVELS=new Set(["minimal","low","medium","high","xhigh"]);

export const CONFIG_DEFAULTS={
  sessionDb:join(homedir(),".zcode","cli","db","db.sqlite"),
  indexDb:join(homedir(),".zcode","v2","tasks-index.sqlite"),
  gatewayConfigPath:join(homedir(),".zcode","tools","suian-zcode-gateway","config.json"),
  titlePolicyDirectory:join(homedir(),".zcode","tools","suian-zcode-common","session-titles"),
  timeoutMs:120000,
  maxOutputTokens:2048,
  sqliteBin:"sqlite3",
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

// 管理命令（enable/status/lock 等）不依赖会话；run 命令必须完整配置。
export const SESSION_FREE_COMMANDS=["enable","disable","status","models","doctor","probe","policy","lock","unlock"];

export function validateSelection(selection,view) {
  if(!selection||typeof selection!=="object")return "selection 必须是对象";
  const {providerId,modelId}=selection;
  if(typeof providerId!=="string"||!PROVIDER_ID_RE.test(providerId))return "selection.providerId 无效";
  if(typeof modelId!=="string"||!MODEL_ID_RE.test(modelId))return "selection.modelId 无效";
  const options=selection.options??{};
  const level=options.reasoningLevel;
  if(typeof level!=="string")return "selection.options.reasoningLevel 必须是字符串";
  if(!REASONING_LEVELS.has(level))return `selection.options.reasoningLevel 不在支持范围：${[...REASONING_LEVELS].join("/")}`;
  if(!view)return null;
  const provider=(view.providers??[]).find(p=>p.providerId===providerId);
  const model=provider?.models?.find(m=>m.modelId===modelId);
  if(!model)return "指定模型不在原 Host 的可用目录中";
  const values=model.config?.optionSpecs?.reasoningLevel?.values;
  if(Array.isArray(values)&&!values.includes(level))return "指定思考档位不可用";
  return null;
}

// 校验并合并配置；错误返回 {error}，成功返回完整配置。
// allowDisabled：管理命令需要读配置改开关，不把 enabled:false 当错误。
export async function loadConfig(configPath,{env=process.env,allowDisabled=false}={}) {
  let supplied={};
  try {
    const parsed=await readJsonOptional(configPath);
    if(parsed===null)return {error:"not_configured",message:"配置文件不存在："+configPath};
    supplied=parsed;
  } catch(error) {
    if(error instanceof SyntaxError)return {error:"invalid_config",message:"配置文件 JSON 无效："+configPath};
    throw error;
  }
  if(typeof supplied!=="object"||supplied===null||Array.isArray(supplied))return {error:"invalid_config",message:"配置必须是 JSON 对象"};
  if(supplied.enabled===false&&!allowDisabled)return {error:"disabled",message:"自动命名已暂停"};
  const config={
    ...CONFIG_DEFAULTS,
    ...supplied,
    sqliteBin:supplied.sqliteBin??env.SQLITE_BIN??CONFIG_DEFAULTS.sqliteBin,
    rename:{...CONFIG_DEFAULTS.rename,...(supplied.rename??"")}
  };
  const selectionError=validateSelection(config.selection);
  if(selectionError)return {error:"selection_invalid",message:selectionError};
  if(!Number.isInteger(config.timeoutMs)||config.timeoutMs<1000||config.timeoutMs>300000)return {error:"invalid_config",message:"timeoutMs 应在 1000–300000 范围内"};
  if(!Number.isInteger(config.maxOutputTokens)||config.maxOutputTokens<256||config.maxOutputTokens>16384)return {error:"invalid_config",message:"maxOutputTokens 应在 256–16384 范围内"};
  if(config.rename.maxTitleChars<10||config.rename.maxTitleChars>96)return {error:"invalid_config",message:"rename.maxTitleChars 应在 10–96 范围内"};
  if(config.rename.minTitleChars<3||config.rename.minTitleChars>=config.rename.maxTitleChars)return {error:"invalid_config",message:"rename.minTitleChars 应小于 maxTitleChars"};
  if(!Number.isInteger(config.rename.maxTurns)||config.rename.maxTurns<1||config.rename.maxTurns>20)return {error:"invalid_config",message:"rename.maxTurns 应在 1–20 范围内"};
  return {config};
}
