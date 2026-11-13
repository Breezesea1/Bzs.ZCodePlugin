import test from "node:test";
import assert from "node:assert/strict";
import {createBackend} from "../backend.mjs";

const config={
  sessionDb:"D:/no-such-db.sqlite",indexDb:"D:/no-such-index.sqlite",
  timeoutMs:5000,maxOutputTokens:2048,
  titlePolicyDirectory:"D:/no-such-policy"
};
const event={session_id:"sess_direct1",workspace_path:"D:\\w"};
const sampleCatalog={
  providers:[
    {
      providerId:"magpie",
      providerName:"magpie",
      config:{api:{type:"openai-responses",baseUrl:"http://127.0.0.1:3425"},access:{type:"api-key",apiKey:"k"}},
      models:[
        {modelId:"bzs/group/gemini-4-carbon",config:{optionSpecs:{reasoningLevel:{values:["low","medium","high"]}}}}
      ]
    },
    {
      providerId:"openrouter-custom",
      providerName:"OpenRouter",
      config:{api:{type:"anthropic-messages",baseUrl:"https://openrouter.ai/api"},access:{type:"api-key",apiKey:"or"}},
      models:[
        {modelId:"anthropic/claude-sonnet-5.5",config:{optionSpecs:{reasoningLevel:{values:["low","high"]}}}}
      ]
    }
  ]
};

test("构造：无效 session_id 直接拒绝",()=>{
  assert.throws(()=>createBackend({event:{session_id:"bad"},config,prompt:"p"}),/session_id/);
});

test("generate：宿主目录中的任意渠道与模型均可校验通过并透传 provider/model 配置调用",async()=>{
  let captured=null;
  const backend=createBackend({
    event,config,prompt:"p",catalog:sampleCatalog,
    generate:async args=>{captured=args;return{text:"ok"};},
    env:{}
  });
  const result=await backend.generate({},{providerId:"magpie",modelId:"bzs/group/gemini-4-carbon",options:{reasoningLevel:"low"}});
  assert.equal(result.text,"ok");
  assert.equal(captured.provider.providerId,"magpie");
  assert.equal(captured.model.modelId,"bzs/group/gemini-4-carbon");
  backend.close();
});

test("generate：目录校验不过时直接拒绝，不发起模型调用",async()=>{
  let called=0;
  const backend=createBackend({
    event,config,prompt:"p",catalog:sampleCatalog,
    generate:async()=>{called++;return{};},
    env:{}
  });
  await assert.rejects(
    ()=>backend.generate({},{providerId:"unknown-provider",modelId:"M",options:{reasoningLevel:"low"}}),
    /不在宿主可用模型目录中/
  );
  assert.equal(called,0);
  backend.close();
});

test("rename：索引无目标行时抛错（直写失败不静默）",async()=>{
  const backend=createBackend({event,config,prompt:"p",catalog:sampleCatalog,env:{}});
  await assert.rejects(()=>backend.rename("新标题"),/改名未生效|任务索引/);
  backend.close();
});
