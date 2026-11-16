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

async function migrationSandbox(t,legacy) {
  const sandbox=await makeSandbox();
  t.after(sandbox.cleanup);
  const legacyDir=join(sandbox.dir,".zcode","bzs-zcode-session-title");
  await mkdir(legacyDir,{recursive:true});
  const legacyPath=join(legacyDir,"config.json");
  await writeConfig(legacyPath,legacy);
  return {...sandbox,legacyDir,legacyPath,configPath:join(sandbox.dataPath,"config.json"),
    env:{USERPROFILE:sandbox.dir,HOME:sandbox.dir,ZCODE_PLUGIN_DATA:sandbox.dataPath}};
}

test("CLI status：自动迁移旧配置，保留选择、开关、自定义字段和旧状态目录",async t=>{
  const legacy={selection,enabled:false,timeoutMs:123456,rename:{maxTurns:8},custom:"retained"};
  const {configPath,legacyPath,legacyDir,env}=await migrationSandbox(t,legacy);
  const {code,out}=await runCli(["status"],{},{env});
  assert.equal(code,0);
  const result=JSON.parse(out);
  assert.equal(result.enabled,false);
  assert.deepEqual(result.selection,selection);
  assert.equal(result.dataDir,join(legacyDir,"state"));
  assert.deepEqual(JSON.parse(await readFile(configPath,"utf8")),{...legacy,dataDir:join(legacyDir,"state")});
  assert.deepEqual(JSON.parse(await readFile(legacyPath,"utf8")),legacy);
});

test("CLI status：并发迁移保留旧配置中相对 dataDir 的含义",async t=>{
  const legacy={selection,enabled:true,dataDir:"custom-state"};
  const {configPath,legacyDir,env}=await migrationSandbox(t,legacy);
  const results=await Promise.all([runCli(["status"],{},{env}),runCli(["status"],{},{env})]);
  for(const {code,out} of results) {
    assert.equal(code,0);
    assert.equal(JSON.parse(out).dataDir,join(legacyDir,"custom-state"));
  }
  assert.deepEqual(JSON.parse(await readFile(configPath,"utf8")),{...legacy,dataDir:join(legacyDir,"custom-state")});
});

test("CLI status：已有新配置不被旧配置覆盖",async t=>{
  const {configPath,env}=await migrationSandbox(t,{selection,enabled:true});
  const current={selection,enabled:false,rename:{maxTurns:3}};
  await writeConfig(configPath,current);
  const {code,out}=await runCli(["status"],{},{env});
  assert.equal(code,0);
  assert.equal(JSON.parse(out).enabled,false);
  assert.deepEqual(JSON.parse(await readFile(configPath,"utf8")),current);
});

test("CLI status：无新旧配置时为插件数据目录生成默认 config.json",async t=>{
  const sandbox=await makeSandbox();
  t.after(sandbox.cleanup);
  const v2Dir=join(sandbox.dir,"v2");
  await mkdir(v2Dir,{recursive:true});
  const personalPath=join(v2Dir,"provider_config.json");
  await writeFile(personalPath,JSON.stringify({
    schemaVersion:1,
    config:{
      providerConfigRules:{
        providerRules:[{
          providerId:"magpie",
          providerName:"magpie",
          enabled:true,
          config:{
            access:{type:"api-key",apiKey:"k"},
            api:{type:"openai-responses",baseUrl:"http://127.0.0.1:3425"},
            personalModelIds:["bzs/auto/gpt-6.1-sol","bzs/group/deepseek-flash"]
          }
        }]
      },
      modelConfigRules:{
        providerModelRules:[
          {providerId:"magpie",modelId:"bzs/group/deepseek-flash",config:{optionSpecs:{reasoningLevel:{values:["low","high"]}}}}
        ],
        manualProviderModelRules:[]
      }
    }
  }));
  const configPath=join(sandbox.dataPath,"config.json");
  const {code,out}=await runCli(["status"],{},{
    env:{
      USERPROFILE:sandbox.dir,
      HOME:sandbox.dir,
      LOCALAPPDATA:join(sandbox.dir,"AppData","Local"),
      ZCODE_PLUGIN_DATA:sandbox.dataPath,
      BZS_TITLE_ZCODE_V2_DIR:v2Dir,
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE:join(v2Dir,"none.json"),
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE:personalPath,
      BZS_TITLE_CREDENTIALS:join(v2Dir,"none-creds.json")
    }
  });
  assert.equal(code,0);
  const status=JSON.parse(out);
  assert.equal(status.status,"status");
  assert.equal(status.enabled,true);
  assert.deepEqual(status.selection,{providerId:"magpie",modelId:"bzs/group/deepseek-flash",options:{reasoningLevel:"low"}});
  const saved=JSON.parse(await readFile(configPath,"utf8"));
  assert.equal(saved.enabled,true);
  assert.equal(saved.rename.maxTurns,6);
});

test("CLI run：显式指定其他路径时不迁移全局旧配置",async t=>{
  const {dataPath,env}=await migrationSandbox(t,{selection});
  const {code,out}=await runCli(["run","--config",join(dataPath,"other.json")],{},{env});
  assert.equal(code,0);
  assert.equal(JSON.parse(out).status,"not_configured");
});

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

test("CLI models：无 config.json 时也能直接读取宿主模型目录",async()=>{
  const {dir,dataPath,cleanup}=await makeSandbox();
  const v2Dir=join(dir,"v2");
  await mkdir(v2Dir,{recursive:true});
  const personalPath=join(v2Dir,"provider_config.json");
  await writeFile(personalPath,JSON.stringify({
    schemaVersion:1,
    config:{
      providerConfigRules:{
        providerRules:[{
          providerId:"magpie",
          providerName:"magpie",
          enabled:true,
          config:{
            access:{type:"api-key",apiKey:"k"},
            api:{type:"openai-responses",baseUrl:"http://127.0.0.1:3425"},
            personalModelIds:["bzs/group/gemini-4-carbon"]
          }
        }]
      },
      modelConfigRules:{providerModelRules:[],manualProviderModelRules:[]}
    }
  }));
  const {code,out}=await runCli(["models","--config",join(dataPath,"no-config-yet.json")],{},{
    env:{
      BZS_TITLE_ZCODE_V2_DIR:v2Dir,
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE:join(v2Dir,"none.json"),
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE:personalPath,
      BZS_TITLE_CREDENTIALS:join(v2Dir,"none-creds.json")
    }
  });
  assert.equal(code,0);
  const result=JSON.parse(out);
  assert.equal(result.status,"models");
  assert.equal(result.providers[0].providerId,"magpie");
  assert.equal(result.providers[0].models[0].modelId,"bzs/group/gemini-4-carbon");
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
