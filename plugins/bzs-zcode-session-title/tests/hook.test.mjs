import test from "node:test";
import assert from "node:assert/strict";
import {dispatchStopEvent} from "../hook.mjs";
import {spawn} from "node:child_process";
import {mkdtemp,mkdir,writeFile,readFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";

async function runHook(t,{legacy,current,raw,personalConfig,hookEvent=event,args}={}){
  const dir=await mkdtemp(join(tmpdir(),"bzs-hook-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const dataPath=join(dir,"plugin-data"),legacyDir=join(dir,".zcode","bzs-zcode-session-title");
  await mkdir(dataPath,{recursive:true});
  if(legacy) {
    await mkdir(legacyDir,{recursive:true});
    await writeFile(join(legacyDir,"config.json"),JSON.stringify(legacy));
  }
  const v2Dir=join(dir,".zcode","v2");
  if(personalConfig) {
    await mkdir(v2Dir,{recursive:true});
    await writeFile(join(v2Dir,"provider_config.json"),JSON.stringify(personalConfig));
  }
  const configPath=join(dataPath,"config.json");
  if(current||raw)await writeFile(configPath,raw??JSON.stringify(current));
  const childEnv={...process.env,USERPROFILE:dir,HOME:dir,LOCALAPPDATA:join(dir,"AppData","Local"),ZCODE_PLUGIN_DATA:dataPath,BZS_TITLE_ZCODE_V2_DIR:v2Dir};
  delete childEnv.BZS_TITLE_DATA;
  delete childEnv.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
  delete childEnv.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
  delete childEnv.BZS_TITLE_CREDENTIALS;
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[join(import.meta.dirname,"..","hook.mjs"),...(args??["--config",configPath])],{
      windowsHide:true,stdio:["pipe","pipe","pipe"],
      env:childEnv
    });
    let out="",err="";
    child.stdout.on("data",c=>out+=c);
    child.stderr.on("data",c=>err+=c);
    child.on("error",reject);
    child.on("close",code=>resolve({code,out,err}));
    child.stdin.end(JSON.stringify(hookEvent));
  });
  return {...result,dir,dataPath,legacyDir,configPath,logPath:join(dataPath,"state","hook.log.jsonl")};
}

const event={session_id:"sess_abc123",workspace_path:"D:\\proj",stop_hook_active:false,hook_event_name:"Stop"};
const sessionStartEvent={session_id:"sess_abc123",workspace_path:"D:\\proj",hook_event_name:"SessionStart",source:"startup"};
const samplePersonalConfig={
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
        {providerId:"magpie",modelId:"bzs/group/deepseek-flash",config:{optionSpecs:{reasoningLevel:{values:["low","medium","high"]}}}}
      ],
      manualProviderModelRules:[]
    }
  }
};

test("Hook：新用户无宿主模型触发 Stop 时生成暂停的默认配置并跳过派发",async t=>{
  const {code,out,logPath,configPath}=await runHook(t);
  assert.equal(code,0);
  assert.match(out,/"action":"disabled"/);
  const generated=JSON.parse(await readFile(configPath,"utf8"));
  assert.equal(generated.enabled,false);
  assert.equal(generated.dataDir,"state");
  assert.equal(generated.rename.maxTurns,6);
  const log=JSON.parse((await readFile(logPath,"utf8")).trim());
  assert.equal(log.action,"disabled");
});

test("Hook：SessionStart 新用户有可用宿主模型时自动生成已启用的默认配置且 stdout 保持静默",async t=>{
  const {code,out,err,logPath,configPath}=await runHook(t,{
    personalConfig:samplePersonalConfig,
    hookEvent:sessionStartEvent,
    args:["--init","--config","${ZCODE_PLUGIN_DATA}/config.json"]
  });
  assert.equal(code,0);
  assert.equal(out,"");
  assert.equal(err,"");
  const generated=JSON.parse(await readFile(configPath,"utf8"));
  assert.equal(generated.enabled,true);
  assert.deepEqual(generated.selection,{
    providerId:"magpie",
    modelId:"bzs/group/deepseek-flash",
    options:{reasoningLevel:"low"}
  });
  const log=JSON.parse((await readFile(logPath,"utf8")).trim());
  assert.equal(log.event,"SessionStart");
  assert.equal(log.action,"initialized");
});

test("Hook：SessionStart 无宿主模型时生成 enabled=false 的默认配置且不覆盖已有配置",async t=>{
  const first=await runHook(t,{hookEvent:sessionStartEvent});
  assert.equal(first.code,0);
  assert.equal(first.out,"");
  const generated=JSON.parse(await readFile(first.configPath,"utf8"));
  assert.equal(generated.enabled,false);
  assert.equal(generated.selection.modelId,"GLM-5.3-Flash");
  const log=JSON.parse((await readFile(first.logPath,"utf8")).trim());
  assert.equal(log.action,"initialized");

  const existing={selection:{providerId:"custom",modelId:"m1",options:{reasoningLevel:"high"}},enabled:false,note:"keep"};
  const second=await runHook(t,{current:existing,hookEvent:sessionStartEvent});
  assert.equal(second.code,0);
  assert.equal(second.out,"");
  assert.deepEqual(JSON.parse(await readFile(second.configPath,"utf8")),existing);
  await assert.rejects(readFile(second.logPath),{code:"ENOENT"});
});

test("Hook：SessionStart 遇到旧配置时优先迁移并保留原有设置",async t=>{
  const legacy={selection:{providerId:"magpie",modelId:"test",options:{reasoningLevel:"low"}},enabled:false};
  const {code,out,legacyDir,configPath}=await runHook(t,{legacy,personalConfig:samplePersonalConfig,hookEvent:sessionStartEvent});
  assert.equal(code,0);
  assert.equal(out,"");
  assert.deepEqual(JSON.parse(await readFile(configPath,"utf8")),{...legacy,dataDir:join(legacyDir,"state")});
  const log=JSON.parse((await readFile(join(legacyDir,"state","hook.log.jsonl"),"utf8")).trim());
  assert.equal(log.event,"SessionStart");
  assert.equal(log.action,"migrated");
});

test("Hook：SessionStart 配置 JSON 损坏时不覆盖且记录 error（stdout 静默）",async t=>{
  const {code,out,configPath,logPath}=await runHook(t,{raw:"{broken",hookEvent:sessionStartEvent});
  assert.equal(code,0);
  assert.equal(out,"");
  assert.equal(await readFile(configPath,"utf8"),"{broken");
  const log=JSON.parse((await readFile(logPath,"utf8")).trim());
  assert.equal(log.event,"SessionStart");
  assert.equal(log.action,"error");
});

test("Hook：自动迁移已暂停的旧配置，并记录 disabled",async t=>{
  const legacy={selection:{providerId:"magpie",modelId:"test",options:{reasoningLevel:"low"}},enabled:false};
  const {code,out,legacyDir,configPath}=await runHook(t,{legacy});
  assert.equal(code,0);
  assert.match(out,/"action":"disabled"/);
  assert.deepEqual(JSON.parse(await readFile(configPath,"utf8")),{...legacy,dataDir:join(legacyDir,"state")});
  const log=JSON.parse((await readFile(join(legacyDir,"state","hook.log.jsonl"),"utf8")).trim());
  assert.equal(log.action,"disabled");
});

test("Hook：配置 JSON 损坏时记录 error，不误报 dispatched",async t=>{
  const {code,out,logPath}=await runHook(t,{raw:"{broken"});
  assert.equal(code,0);
  assert.match(out,/hook-error/);
  const log=JSON.parse((await readFile(logPath,"utf8")).trim());
  assert.equal(log.action,"error");
  assert.ok(log.error);
});

test("dispatchStopEvent：延迟后派发 worker",async()=>{
  const spawned=[];
  await dispatchStopEvent({
    payload:event,dataDir:"D:/tmp",pluginRoot:"P:/plugin",configPath:"C:/cfg.json",startDelayMs:1,
    spawnWorker:async({script,args,event:e,dataDir})=>{spawned.push({script,args,event:e,dataDir});}
  });
  assert.equal(spawned.length,1);
  assert.match(spawned[0].script,/cli\.mjs$/);
  assert.deepEqual(spawned[0].args,["run","--apply","--config","C:/cfg.json"]);
  assert.equal(spawned[0].event.session_id,"sess_abc123");
});

test("dispatchStopEvent：stop_hook_active 跳过续跑轮",async()=>{
  const spawned=[];
  const result=await dispatchStopEvent({payload:{...event,stop_hook_active:true},dataDir:"D:/tmp",pluginRoot:"P:/plugin",startDelayMs:0,spawnWorker:async()=>spawned.push(1)});
  assert.equal(result.action,"skipped_stale");
  assert.equal(spawned.length,0);
});

test("dispatchStopEvent：无效 payload 忽略",async()=>{
  for(const payload of [null,undefined,"x",{session_id:"bad id",workspace_path:"D:\\"},{session_id:"sess_ok"}]) {
    const result=await dispatchStopEvent({payload,dataDir:"D:/tmp",pluginRoot:"P:/plugin",startDelayMs:0,spawnWorker:async()=>assert.fail("不应派发")});
    assert.equal(result.action,"ignored_invalid",JSON.stringify(payload));
  }
});

test("dispatchStopEvent：无 configPath 时不带 --config 参数",async()=>{
  const spawned=[];
  await dispatchStopEvent({payload:event,dataDir:"D:/tmp",pluginRoot:"P:/plugin",configPath:null,startDelayMs:0,spawnWorker:async s=>spawned.push(s)});
  assert.deepEqual(spawned[0].args,["run","--apply"]);
});
