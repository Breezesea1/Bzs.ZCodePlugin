import test from "node:test";
import assert from "node:assert/strict";
import {loadConfig,validateSelection,resolveDataDir,pickDefaultSelection,buildDefaultConfig,ensureConfig,CONFIG_DEFAULTS} from "../config.mjs";
import {writeFile,readFile,mkdir,rm} from "node:fs/promises";
import {join,win32} from "node:path";
import {tmpdir} from "node:os";

async function withConfig(content) {
  const dir=join(tmpdir(),"bzs-title-test-"+Math.random().toString(36).slice(2));
  await mkdir(dir,{recursive:true});
  const path=join(dir,"config.json");
  await writeFile(path,typeof content==="string"?content:JSON.stringify(content));
  return {dir,path,cleanup:()=>rm(dir,{recursive:true,force:true})};
}

const validSelection={providerId:"magpie",modelId:"bzs/auto/gpt-6.1-sol",options:{reasoningLevel:"ultra"}};

test("loadConfig：不存在时报 not_configured",async()=>{
  const path=join(tmpdir(),"no-such-"+Date.now()+"-"+Math.random().toString(36).slice(2)+".json");
  const result=await loadConfig(path);
  assert.equal(result.error,"not_configured");
});

test("loadConfig：JSON 无效时报 invalid_config",async()=>{
  const {path,cleanup}=await withConfig("{broken");
  const result=await loadConfig(path);
  assert.equal(result.error,"invalid_config");
  await cleanup();
});

test("loadConfig：enabled=false 报 disabled",async()=>{
  const {path,cleanup}=await withConfig({enabled:false,selection:validSelection});
  assert.equal((await loadConfig(path)).error,"disabled");
  await cleanup();
});

test("loadConfig：完整配置合并默认值并支持宿主任意合法档位名（如 ultra/max/disabled/enabled）",async()=>{
  for(const level of ["disabled","enabled","none","off","low","medium","high","xhigh","max","ultra"]) {
    const {path,cleanup}=await withConfig({selection:{...validSelection,options:{reasoningLevel:level}}});
    const {config,error}=await loadConfig(path);
    assert.equal(error,undefined,level);
    assert.equal(config.timeoutMs,CONFIG_DEFAULTS.timeoutMs);
    assert.equal(config.rename.maxTitleChars,48);
    assert.equal(config.rename.maxTurns,6);
    await cleanup();
  }
});

test("loadConfig：selection 缺失或字段格式非法时拒绝",async()=>{
  const a=await withConfig({});
  assert.equal((await loadConfig(a.path)).error,"selection_invalid");
  await a.cleanup();

  const b=await withConfig({selection:{providerId:"magpie",modelId:"m",options:{reasoningLevel:""}}});
  const resB=await loadConfig(b.path);
  assert.equal(resB.error,"selection_invalid");
  assert.match(resB.message,/reasoningLevel/);
  await b.cleanup();
});

test("loadConfig：timeoutMs/maxOutputTokens 范围校验",async()=>{
  for(const patch of [{timeoutMs:100},{timeoutMs:400000},{maxOutputTokens:100},{maxOutputTokens:99999}]) {
    const {path,cleanup}=await withConfig({selection:validSelection,...patch});
    const result=await loadConfig(path);
    assert.equal(result.error,"invalid_config",JSON.stringify(patch));
    await cleanup();
  }
});

test("loadConfig：rename 参数范围校验",async()=>{
  for(const patch of [{rename:{maxTitleChars:5}},{rename:{minTitleChars:50}},{rename:{maxTurns:0}},{rename:{maxTurns:99}}]) {
    const {path,cleanup}=await withConfig({selection:validSelection,...patch});
    const result=await loadConfig(path);
    assert.equal(result.error,"invalid_config",JSON.stringify(patch));
    await cleanup();
  }
});

test("loadConfig：已废弃的 sqliteBin / gateway / model 字段被静默丢弃",async()=>{
  const {path,cleanup}=await withConfig({
    selection:validSelection,
    sqliteBin:"C:/bin/sqlite3.exe",
    gateway:{mode:"direct"},
    model:{source:"host-follow"}
  });
  const {config,error}=await loadConfig(path,{env:{}});
  assert.equal(error,undefined);
  assert.equal(config.sqliteBin,undefined);
  assert.equal(config.gateway,undefined);
  assert.equal(config.model,undefined);
  await cleanup();
});

test("validateSelection：对照宿主目录视图校验渠道、模型与档位",()=>{
  const view={
    providers:[
      {
        providerId:"magpie",
        models:[
          {modelId:"bzs/group/gemini-4-carbon",config:{optionSpecs:{reasoningLevel:{values:["low","medium","high"]}}}}
        ]
      }
    ]
  };
  assert.equal(validateSelection({providerId:"magpie",modelId:"bzs/group/gemini-4-carbon",options:{reasoningLevel:"medium"}},view),null);
  assert.match(validateSelection({providerId:"nope",modelId:"bzs/group/gemini-4-carbon",options:{reasoningLevel:"low"}},view),/渠道不在宿主可用模型目录中/);
  assert.match(validateSelection({providerId:"magpie",modelId:"Nope",options:{reasoningLevel:"low"}},view),/模型不在宿主可用模型目录中/);
  assert.match(validateSelection({providerId:"magpie",modelId:"bzs/group/gemini-4-carbon",options:{reasoningLevel:"ultra"}},view),/档位不可用/);
});

test("resolveDataDir：env > 配置字段 > 默认 state",()=>{
  const configPath="D:/data/config.json";
  assert.equal(resolveDataDir(configPath,{},{}),win32.resolve("D:/data","state"));
  assert.equal(resolveDataDir(configPath,{dataDir:"custom"},{}),win32.resolve("D:/data","custom"));
  assert.equal(resolveDataDir(configPath,{dataDir:"custom"},{BZS_TITLE_DATA:"E:/env"}),win32.resolve("E:/env"));
});

test("pickDefaultSelection：优先轻量高速模型并匹配低思考档位，空目录返回 null",()=>{
  assert.equal(pickDefaultSelection({providers:[]}),null);
  const catalog={
    providers:[
      {
        providerId:"account:bigmodel-individual-coding-plan",
        models:[
          {modelId:"GLM-5.3",config:{optionSpecs:{reasoningLevel:{values:["low","high","max"]}}}},
          {modelId:"GLM-5.3-Flash",config:{optionSpecs:{reasoningLevel:{values:["low","high","max"]}}}}
        ]
      },
      {
        providerId:"magpie",
        models:[
          {modelId:"bzs/group/deepseek-flash",config:{optionSpecs:{reasoningLevel:{values:["low","medium","high"]}}}}
        ]
      }
    ]
  };
  assert.deepEqual(pickDefaultSelection(catalog),{
    providerId:"account:bigmodel-individual-coding-plan",
    modelId:"GLM-5.3-Flash",
    options:{reasoningLevel:"low"}
  });

  const reasonerCatalog={
    providers:[
      {
        providerId:"my-ds",
        models:[
          {modelId:"deepseek-reasoner",config:{optionSpecs:{reasoningLevel:{values:["disabled","enabled"]}}}},
          {modelId:"deepseek-chat",config:{optionSpecs:{reasoningLevel:{values:["disabled","enabled"]}}}}
        ]
      }
    ]
  };
  assert.deepEqual(pickDefaultSelection(reasonerCatalog),{
    providerId:"my-ds",
    modelId:"deepseek-chat",
    options:{reasoningLevel:"disabled"}
  });
});

test("buildDefaultConfig 与 ensureConfig：有可用宿主模型时生成 enabled=true，空目录回落 enabled=false",async t=>{
  const root=join(tmpdir(),"bzs-title-init-"+Math.random().toString(36).slice(2));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const v2Dir=join(root,"v2");
  const dataDir=join(root,"plugin-data");
  await mkdir(v2Dir,{recursive:true});

  const emptyEnv={
    USERPROFILE:root,
    HOME:root,
    ZCODE_PLUGIN_DATA:dataDir,
    BZS_TITLE_ZCODE_V2_DIR:v2Dir,
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE:join(v2Dir,"missing-builtin.json"),
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE:join(v2Dir,"missing-personal.json"),
    BZS_TITLE_CREDENTIALS:join(v2Dir,"missing-creds.json")
  };
  const emptyDef=await buildDefaultConfig({env:emptyEnv});
  assert.equal(emptyDef.enabled,false);
  assert.equal(emptyDef.selection.modelId,"GLM-5.3-Flash");
  assert.equal(emptyDef.rename.maxTurns,6);

  const explicitPath=join(root,"other.json");
  assert.deepEqual(await ensureConfig(explicitPath,{env:emptyEnv}),{config:null,origin:"missing"});

  const personalPath=join(v2Dir,"provider_config.json");
  await writeFile(personalPath,JSON.stringify({
    schemaVersion:1,
    config:{
      providerConfigRules:{
        providerRules:[{
          providerId:"my-or",
          providerName:"OR",
          enabled:true,
          config:{
            access:{type:"api-key",apiKey:"sk-test"},
            api:{type:"openai-chat-completions",baseUrl:"https://openrouter.ai/api/v1"},
            personalModelIds:["anthropic/claude-opus-4","google/gemini-3.8-flash"]
          }
        }]
      },
      modelConfigRules:{providerModelRules:[],manualProviderModelRules:[]}
    }
  }));
  const env={...emptyEnv,ZCODE_PERSONAL_PROVIDER_CONFIG_FILE:personalPath};
  const pluginConfigPath=join(dataDir,"config.json");
  const first=await ensureConfig(pluginConfigPath,{env});
  assert.equal(first.origin,"initialized");
  assert.equal(first.config.enabled,true);
  assert.deepEqual(first.config.selection,{
    providerId:"my-or",
    modelId:"google/gemini-3.8-flash",
    options:{reasoningLevel:"disabled"}
  });
  const onDisk=JSON.parse(await readFile(pluginConfigPath,"utf8"));
  assert.deepEqual(onDisk,first.config);

  const second=await ensureConfig(pluginConfigPath,{env});
  assert.equal(second.origin,"existing");
});
