import test from "node:test";
import assert from "node:assert/strict";
import {dispatchStopEvent} from "../hook.mjs";

const event={session_id:"sess_abc123",workspace_path:"D:\\proj",stop_hook_active:false,hook_event_name:"Stop"};

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
