import test from "node:test";
import assert from "node:assert/strict";
import {dispatchStopEvent} from "../hook.mjs";
import {spawn} from "node:child_process";
import {mkdtemp,mkdir,writeFile,readFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";

async function runHook(t,{legacy,current,raw}={}) {
  const dir=await mkdtemp(join(tmpdir(),"bzs-hook-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const dataPath=join(dir,"plugin-data"),legacyDir=join(dir,".zcode","bzs-zcode-session-title");
  await mkdir(dataPath,{recursive:true});
  if(legacy) {
    await mkdir(legacyDir,{recursive:true});
    await writeFile(join(legacyDir,"config.json"),JSON.stringify(legacy));
  }
  const configPath=join(dataPath,"config.json");
  if(current||raw)await writeFile(configPath,raw??JSON.stringify(current));
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[join(import.meta.dirname,"..","hook.mjs"),"--config",configPath],{
      windowsHide:true,stdio:["pipe","pipe","pipe"],
      env:{...process.env,USERPROFILE:dir,HOME:dir,ZCODE_PLUGIN_DATA:dataPath,BZS_TITLE_DATA:undefined}
    });
    let out="",err="";
    child.stdout.on("data",c=>out+=c);
    child.stderr.on("data",c=>err+=c);
    child.on("error",reject);
    child.on("close",code=>resolve({code,out,err}));
    child.stdin.end(JSON.stringify(event));
  });
  return {...result,dataPath,legacyDir,configPath,logPath:join(dataPath,"state","hook.log.jsonl")};
}

const event={session_id:"sess_abc123",workspace_path:"D:\\proj",stop_hook_active:false,hook_event_name:"Stop"};

test("Hook：没有新旧配置时记录 not_configured，不派发 worker",async t=>{
  const {code,out,logPath,configPath}=await runHook(t);
  assert.equal(code,0);
  assert.match(out,/"action":"not_configured"/);
  const log=JSON.parse((await readFile(logPath,"utf8")).trim());
  assert.equal(log.action,"not_configured");
  await assert.rejects(readFile(configPath),{code:"ENOENT"});
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
