import test from "node:test";
import assert from "node:assert/strict";
import {createBackend} from "../backend.mjs";

const config={
  sessionDb:"D:/no-such-db.sqlite",indexDb:"D:/no-such-index.sqlite",
  timeoutMs:5000,
  titlePolicyDirectory:"D:/no-such-policy"
};
const event={session_id:"sess_direct1",workspace_path:"D:\w"};

test("构造：无效 session_id 直接拒绝",()=>{
  assert.throws(()=>createBackend({event:{session_id:"bad"},config,prompt:"p"}),/session_id/);
});

test("generate：目录校验不过时直接拒绝，不发起模型调用",async()=>{
  let called=0;
  const backend=createBackend({
    event,config,prompt:"p",
    generate:async()=>{called++;return{};},
    env:{}
  });
  await assert.rejects(
    ()=>backend.generate({},{providerId:"unknown-provider",modelId:"M",options:{reasoningLevel:"low"}}),
    /不在直连目录中|providerId/
  );
  assert.equal(called,0);
});

test("rename：索引无目标行时抛错（直写失败不静默）",async()=>{
  const backend=createBackend({event,config,prompt:"p",env:{}});
  await assert.rejects(()=>backend.rename("新标题"),/改名未生效|任务索引/);
  backend.close();
});
