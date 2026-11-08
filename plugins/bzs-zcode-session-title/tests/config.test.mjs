import test from "node:test";
import assert from "node:assert/strict";
import {loadConfig,validateSelection,resolveDataDir,CONFIG_DEFAULTS} from "../config.mjs";
import {writeFile,mkdir,rm} from "node:fs/promises";
import {join,win32} from "node:path";
import {tmpdir} from "node:os";

async function withConfig(content) {
  const dir=join(tmpdir(),"bzs-title-test-"+Math.random().toString(36).slice(2));
  await mkdir(dir,{recursive:true});
  const path=join(dir,"config.json");
  await writeFile(path,typeof content==="string"?content:JSON.stringify(content));
  return {dir,path,cleanup:()=>rm(dir,{recursive:true,force:true})};
}

const validSelection={providerId:"account:test",modelId:"GLM-Test",options:{reasoningLevel:"low"}};

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

test("loadConfig：完整配置合并默认值",async()=>{
  const {path,cleanup}=await withConfig({selection:validSelection});
  const {config,error}=await loadConfig(path);
  assert.equal(error,undefined);
  assert.equal(config.timeoutMs,CONFIG_DEFAULTS.timeoutMs);
  assert.equal(config.rename.maxTitleChars,48);
  assert.equal(config.rename.maxTurns,6);
  await cleanup();
});

test("loadConfig：selection 无效时拒绝",async()=>{
  const {path,cleanup}=await withConfig({selection:{providerId:"account:test",modelId:"GLM",options:{reasoningLevel:"ultra"}}});
  const result=await loadConfig(path);
  assert.equal(result.error,"selection_invalid");
  assert.match(result.message,/reasoningLevel/);
  await cleanup();
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

test("loadConfig：已废弃的 sqliteBin 字段被忽略",async()=>{
  const {path,cleanup}=await withConfig({selection:validSelection,sqliteBin:"C:/bin/sqlite3.exe"});
  const {config}=await loadConfig(path,{env:{}});
  assert.equal(config.sqliteBin,undefined);
  await cleanup();
});

test("validateSelection：对照目录视图校验模型与档位",()=>{
  const view={providers:[{providerId:"account:test",models:[{modelId:"GLM-Test",config:{optionSpecs:{reasoningLevel:{values:["low","medium"]}}}}]}]};
  assert.equal(validateSelection({providerId:"account:test",modelId:"GLM-Test",options:{reasoningLevel:"medium"}},view),null);
  assert.match(validateSelection({providerId:"account:test",modelId:"Nope",options:{reasoningLevel:"low"}},view),/不在直连目录中/);
  assert.match(validateSelection({providerId:"account:test",modelId:"GLM-Test",options:{reasoningLevel:"xhigh"}},view),/档位不可用/);
});

test("resolveDataDir：env > 配置字段 > 默认 state",()=>{
  const configPath="D:/data/config.json";
  assert.equal(resolveDataDir(configPath,{},{}),win32.resolve("D:/data","state"));
  assert.equal(resolveDataDir(configPath,{dataDir:"custom"},{}),win32.resolve("D:/data","custom"));
  assert.equal(resolveDataDir(configPath,{dataDir:"custom"},{BZS_TITLE_DATA:"E:/env"}),win32.resolve("E:/env"));
});
