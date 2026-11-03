import test from "node:test";
import assert from "node:assert/strict";
import {loadPrompt,executeCommand} from "../commands.mjs";
import {mkdtemp,writeFile,rm,mkdir} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";

const config={rename:{maxTitleChars:42}};

test("loadPrompt：渲染 max_title_chars 占位符",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"bzs-prompt-"));
  await writeFile(join(dir,"prompt.md"),"最长 {{max_title_chars}} 字符","utf8");
  const prompt=await loadPrompt(dir,config);
  assert.equal(prompt,"最长 42 字符");
  await rm(dir,{recursive:true,force:true});
});

test("executeCommand：enable/disable 只改开关并原子写回",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"bzs-cmd-"));
  const configPath=join(dir,"config.json");
  await writeFile(configPath,JSON.stringify({selection:{providerId:"p",modelId:"m",options:{reasoningLevel:"low"}},timeoutMs:123456}),"utf8");
  const disabled=await executeCommand({command:"disable",configPath});
  assert.equal(disabled.status,"disabled");
  const saved=JSON.parse(await writeFile2read(configPath));
  assert.equal(saved.enabled,false);
  assert.equal(saved.timeoutMs,123456);
  const enabled=await executeCommand({command:"enable",configPath});
  assert.equal(enabled.status,"enabled");
  assert.equal(JSON.parse(await writeFile2read(configPath)).enabled,true);
  await rm(dir,{recursive:true,force:true});
});

async function writeFile2read(path){const {readFile}=await import("node:fs/promises");return readFile(path,"utf8");}

test("executeCommand：status 返回配置摘要",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"bzs-cmd-"));
  const result=await executeCommand({command:"status",config:{enabled:true,selection:{modelId:"M"},rename:{}},dataDir:dir});
  assert.equal(result.status,"status");
  assert.equal(result.enabled,true);
  assert.equal(result.selection.modelId,"M");
  assert.equal(result.dataDir,dir);
  await rm(dir,{recursive:true,force:true});
});
