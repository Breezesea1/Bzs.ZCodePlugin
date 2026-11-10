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

test("generate：passthrough 选择只验家族覆盖，允许目录外的宿主裸模型名",async()=>{
  let called=0;
  const backend=createBackend({
    event,config,prompt:"p",
    generate:async()=>{called++;return{text:"host"};},
    env:{}
  });
  // 模型名不在 fixed 候选目录内（glm-5.3-flash），靠显式 passthrough 标记放行
  const result=await backend.generate({},{providerId:"bigmodel",modelId:"glm-5.3-flash",options:{reasoningLevel:"low"},passthrough:true});
  assert.equal(result.text,"host");
  assert.equal(called,1);
  backend.close();
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

test("generate：fixed 模式直接直连",async()=>{
  let called=0;
  const backend=createBackend({
    event,config,prompt:"p",
    generate:async()=>{called++;return{text:"direct"};},
    env:{}
  });
  const result=await backend.generate({},{providerId:"bigmodel",modelId:"GLM-5.3-Flash",options:{reasoningLevel:"low"}});
  assert.equal(result.text,"direct");
  assert.equal(called,1);
  backend.close();
});

test("generate：旧配置残留 gateway 字段不影响直连（0.4.0 起忽略）",async()=>{
  let called=0;
  const legacyConfig={...config,gateway:{mode:"auto"}};
  const backend=createBackend({
    event,config:legacyConfig,prompt:"p",
    generate:async()=>{called++;return{text:"legacy-ok"};},
    env:{}
  });
  const result=await backend.generate({},{providerId:"bigmodel",modelId:"GLM-5.3-Flash",options:{reasoningLevel:"low"}});
  assert.equal(result.text,"legacy-ok");
  assert.equal(called,1);
  backend.close();
});

test("rename：索引无目标行时抛错（直写失败不静默）",async()=>{
  const backend=createBackend({event,config,prompt:"p",env:{}});
  await assert.rejects(()=>backend.rename("新标题"),/改名未生效|任务索引/);
  backend.close();
});
