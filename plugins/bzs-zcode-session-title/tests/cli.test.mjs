import test from "node:test";
import assert from "node:assert/strict";
import {execFile,spawn} from "node:child_process";
import {promisify} from "node:util";
import {mkdtemp,mkdir,writeFile,rm,readFile} from "node:fs/promises";
import {join,dirname} from "node:path";
import {tmpdir} from "node:os";

const run=promisify(execFile);
const PLUGIN_ROOT=join(import.meta.dirname,"..");

async function makeSandbox() {
  const dir=await mkdtemp(join(tmpdir(),"bzs-cli-"));
  const dataPath=join(dir,"data");
  await mkdir(dataPath,{recursive:true});
  return {dir,dataPath,cleanup:()=>rm(dir,{recursive:true,force:true})};
}

function writeConfig(configPath,config) {
  return writeFile(configPath,JSON.stringify(config,null,2));
}

const selection={providerId:"account:test",modelId:"GLM-Test",options:{reasoningLevel:"low"}};

function runCli(args,stdin,{env={}}={}) {
  return new Promise(resolve=>{
    const child=spawn(process.execPath,[join(PLUGIN_ROOT,"cli.mjs"),...args],{
      stdio:["pipe","pipe","pipe"],windowsHide:true,
      env:{...process.env,...env}
    });
    let out="",err="";
    child.stdout.on("data",c=>out+=c);
    child.stderr.on("data",c=>err+=c);
    child.on("close",code=>resolve({code,out,err}));
    child.stdin.end(JSON.stringify(stdin));
  });
}

test("CLI run：未配置时输出 not_configured 且退出码 0",async()=>{
  const {dataPath,cleanup}=await makeSandbox();
  const {code,out}=await runCli(["run","--config",join(dataPath,"config.json")],{session_id:"sess_x",workspace_path:"D:\\w"});
  assert.equal(code,0);
  assert.equal(JSON.parse(out).status,"not_configured");
  await cleanup();
});

test("CLI run：enabled=false 输出 disabled 且退出码 0",async()=>{
  const {dataPath,cleanup}=await makeSandbox();
  const configPath=join(dataPath,"config.json");
  await writeConfig(configPath,{enabled:false,selection});
  const {code,out}=await runCli(["run","--config",configPath],{session_id:"sess_x",workspace_path:"D:\\w"});
  assert.equal(code,0);
  assert.equal(JSON.parse(out).status,"disabled");
  await cleanup();
});

test("CLI run：selection 缺失时报错退出码 1",async()=>{
  const {dataPath,cleanup}=await makeSandbox();
  const configPath=join(dataPath,"config.json");
  await writeConfig(configPath,{});
  const {code,out}=await runCli(["run","--config",configPath],{session_id:"sess_x",workspace_path:"D:\\w"});
  assert.equal(code,1);
  const failure=JSON.parse(out);
  assert.equal(failure.status,"failed");
  assert.match(failure.error,/selection/);
  await cleanup();
});

test("CLI enable/disable：写回开关并保留其他字段",async()=>{
  const {dataPath,cleanup}=await makeSandbox();
  const configPath=join(dataPath,"config.json");
  await writeConfig(configPath,{selection,timeoutMs:123456});
  let {out}=await runCli(["disable","--config",configPath],{});
  assert.equal(JSON.parse(out).status,"disabled");
  let saved=JSON.parse(await readFile(configPath,"utf8"));
  assert.equal(saved.enabled,false);
  assert.equal(saved.timeoutMs,123456);
  ({out}=await runCli(["enable","--config",configPath],{}));
  assert.equal(JSON.parse(out).status,"enabled");
  saved=JSON.parse(await readFile(configPath,"utf8"));
  assert.equal(saved.enabled,true);
  await cleanup();
});

test("CLI status：输出配置摘要",async()=>{
  const {dataPath,cleanup}=await makeSandbox();
  const configPath=join(dataPath,"config.json");
  await writeConfig(configPath,{selection});
  const {code,out}=await runCli(["status","--config",configPath],{});
  assert.equal(code,0);
  const status=JSON.parse(out);
  assert.equal(status.status,"status");
  assert.equal(status.enabled,true);
  assert.equal(status.selection.modelId,"GLM-Test");
  await cleanup();
});

test("CLI run：worker.lock 互斥——占用时报 busy",async()=>{
  const {dataPath,cleanup}=await makeSandbox();
  const configPath=join(dataPath,"config.json");
  await writeConfig(configPath,{selection});
  // CLI 的 dataDir = dirname(configPath)/state = data/state；预创建并占用锁文件
  await mkdir(join(dataPath,"state"),{recursive:true});
  const {open}=await import("node:fs/promises");
  const lease=await open(join(dataPath,"state","worker.lock"),"wx");
  await lease.writeFile("{}");
  await lease.close();
  const {code,out}=await runCli(["run","--config",configPath],{session_id:"sess_x",workspace_path:"D:\\w"});
  assert.equal(code,1);
  assert.match(JSON.parse(out).error,/busy/);
  await cleanup();
});

test("CLI policy：会话不存在时报错",async()=>{
  const {dataPath,cleanup}=await makeSandbox();
  const configPath=join(dataPath,"config.json");
  await writeConfig(configPath,{selection});
  const {code,out}=await runCli(["policy","--config",configPath],{session_id:"sess_missing",workspace_path:"D:\\w"});
  assert.equal(code,1);
  assert.match(JSON.parse(out).error,/不存在/);
  await cleanup();
});

test("CLI models：stdin 空对象不再要求 session_id",async()=>{
  const {dataPath,cleanup}=await makeSandbox();
  const configPath=join(dataPath,"config.json");
  await writeConfig(configPath,{selection});
  const {code,out}=await runCli(["models","--config",configPath],{});
  assert.equal(code,1); // 网关未配置时走 failed，但绝不能是 session_id 校验错
  const failure=JSON.parse(out);
  assert.doesNotMatch(failure.error,/session_id/);
  await cleanup();
});

test("CLI status：stdin 空对象输出配置摘要",async()=>{
  const {dataPath,cleanup}=await makeSandbox();
  const configPath=join(dataPath,"config.json");
  await writeConfig(configPath,{selection});
  const {code,out}=await runCli(["status","--config",configPath],{});
  assert.equal(code,0);
  assert.equal(JSON.parse(out).status,"status");
  await cleanup();
});

test("CLI run：stdin 缺 workspace_path 且会话不在库中时报错而非挂起",async()=>{
  const {dataPath,cleanup}=await makeSandbox();
  const configPath=join(dataPath,"config.json");
  await writeConfig(configPath,{selection});
  const {code,out}=await runCli(["run","--config",configPath],{session_id:"sess_nohome"});
  assert.equal(code,1);
  const failure=JSON.parse(out);
  assert.ok(JSON.stringify(failure).length>0);
  await cleanup();
});
