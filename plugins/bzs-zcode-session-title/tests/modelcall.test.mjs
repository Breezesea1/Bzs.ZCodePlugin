import test from "node:test";
import assert from "node:assert/strict";
import {resolveFamily,modelCatalog,generateText,MINIMAX_MODELS} from "../modelcall.mjs";

test("resolveFamily：minimax/MiniMax 关键词归 minimax 家族",()=>{
  assert.equal(resolveFamily("minimax"),"minimax");
  assert.equal(resolveFamily("magpie/bzs/group/minimax-m3-1-flash"),"minimax");
  assert.equal(resolveFamily("MiniMax-M3"),"minimax");
});

test("resolveFamily：magpie 不含 minimax 时仍归 bigmodel（不误伤 GLM）",()=>{
  assert.equal(resolveFamily("magpie/bzs/group/glm-5.3-flash"),"bigmodel");
  assert.equal(resolveFamily("magpie"),"bigmodel");
  assert.equal(resolveFamily("zai"),"zai");
  assert.equal(resolveFamily("account:bigmodel-start-plan"),"bigmodel");
});

test("resolveFamily：无关 providerId 抛 provider_family_unknown",()=>{
  assert.throws(()=>resolveFamily("openai"),{reasonCode:"provider_family_unknown"});
});

test("modelCatalog：包含 minimax provider 与两个 MiniMax 模型",()=>{
  const view=modelCatalog();
  const provider=view.providers.find(p=>p.providerId==="minimax");
  assert.ok(provider,"minimax provider 缺失");
  assert.equal(provider.anthropicBase,"https://api.minimax.io/anthropic");
  const ids=provider.models.map(m=>m.modelId);
  assert.deepEqual(ids,["MiniMax-M3.1-Flash","MiniMax-M3"]);
  assert.deepEqual(provider.models[0].config.optionSpecs.reasoningLevel.values,["low","medium","high"]);
});

test("MINIMAX_MODELS：M3.1-Flash 不含 minimal 档位（端点不支持 none/关闭思考）",()=>{
  for(const model of MINIMAX_MODELS)assert.ok(!model.config.optionSpecs.reasoningLevel.values.includes("minimal"));
});

test("generateText：minimax 请求体用 output_config.effort 且模型名原样传递",async()=>{
  let captured=null;
  const fakeFetch=async(url,options)=>{
    captured={url,body:JSON.parse(options.body),headers:options.headers};
    return {ok:true,status:200,text:async()=>JSON.stringify({
      content:[{type:"text",text:"ok"}],stop_reason:"end_turn",usage:{input_tokens:1,output_tokens:1}
    })};
  };
  const result=await generateText({
    selection:{providerId:"minimax",modelId:"MiniMax-M3.1-Flash",options:{reasoningLevel:"low"}},
    messages:[{role:"user",content:"hi"}],
    maxOutputTokens:2048,timeoutMs:5000,
    env:{BZS_TITLE_TEST_TOKEN:"test-key"},
    fetchImpl:fakeFetch
  });
  assert.equal(result.text,"ok");
  assert.equal(captured.url,"https://api.minimax.io/anthropic/v1/messages");
  assert.equal(captured.body.model,"MiniMax-M3.1-Flash");
  assert.equal(captured.body.output_config.effort,"low");
  assert.equal(captured.body.max_tokens,8192,"思考共享预算需抬顶");
  assert.equal(captured.body.thinking,undefined,"Anthropic thinking 参数不发给 minimax");
  assert.equal(captured.headers.authorization,"Bearer test-key");
});

test("generateText：minimax minimal 档位映射到 low（端点无 none）",async()=>{
  let captured=null;
  const fakeFetch=async(_url,options)=>{
    captured=JSON.parse(options.body);
    return {ok:true,status:200,text:async()=>JSON.stringify({content:[{type:"text",text:"t"}],stop_reason:"end_turn"})};
  };
  await generateText({
    selection:{providerId:"minimax",modelId:"MiniMax-M3.1-Flash",options:{reasoningLevel:"minimal"}},
    messages:[{role:"user",content:"hi"}],
    maxOutputTokens:2048,timeoutMs:5000,
    env:{BZS_TITLE_TEST_TOKEN:"k"},fetchImpl:fakeFetch
  });
  assert.equal(captured.output_config.effort,"low");
});
