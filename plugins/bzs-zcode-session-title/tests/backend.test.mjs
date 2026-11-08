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

test("generate：auto 模式网关不可达时回落直连（generate 被调）",async()=>{
  let called=0;
  const autoConfig={...config,gateway:{mode:"auto"}};
  const backend=createBackend({
    event,config:autoConfig,prompt:"p",
    generate:async(args)=>{called++;return{text:"fallback"};},
    env:{}
  });
  // 无网关运行：connectHost 读不到 config.json → 抛 gateway_not_configured → 回落
  const result=await backend.generate({},{providerId:"bigmodel",modelId:"GLM-5.3-Flash",options:{reasoningLevel:"low"}});
  assert.equal(result.text,"fallback");
  assert.equal(called,1);
  backend.close();
});

test("generate：direct 模式不走网关，直接直连",async()=>{
  let called=0;
  const directConfig={...config,gateway:{mode:"direct"}};
  const backend=createBackend({
    event,config:directConfig,prompt:"p",
    generate:async()=>{called++;return{text:"direct"};},
    env:{}
  });
  const result=await backend.generate({},{providerId:"bigmodel",modelId:"GLM-5.3-Flash",options:{reasoningLevel:"low"}});
  assert.equal(result.text,"direct");
  assert.equal(called,1);
  backend.close();
});

test("generate：gateway 强制模式网关不可达时抛错（不回落）",async()=>{
  const gwConfig={...config,gateway:{mode:"gateway"}};
  const backend=createBackend({
    event,config:gwConfig,prompt:"p",
    generate:async()=>{throw new Error("不应走到直连");},
    env:{}
  });
  await assert.rejects(
    ()=>backend.generate({},{providerId:"bigmodel",modelId:"GLM-5.3-Flash",options:{reasoningLevel:"low"}}),
    /Desktop|网关/
  );
  backend.close();
});

test("rename：索引无目标行时抛错（直写失败不静默）",async()=>{
  const backend=createBackend({event,config,prompt:"p",env:{}});
  await assert.rejects(()=>backend.rename("新标题"),/改名未生效|任务索引/);
  backend.close();
});
