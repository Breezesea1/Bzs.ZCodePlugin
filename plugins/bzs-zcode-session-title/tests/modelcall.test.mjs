import test from "node:test";
import assert from "node:assert/strict";
import {generateText,normalizeAnthropicBaseUrl,verifyProviderAuth,mintProjectToken} from "../modelcall.mjs";

const sampleMessages=[
  {role:"system",content:"只输出 JSON"},
  {role:"user",content:"{\"current_title\":\"旧标题\"}"}
];

test("normalizeAnthropicBaseUrl：自动补齐 /v1 且不重复追加",()=>{
  assert.equal(normalizeAnthropicBaseUrl("https://api.anthropic.com/v1"),"https://api.anthropic.com/v1");
  assert.equal(normalizeAnthropicBaseUrl("https://openrouter.ai/api/"),"https://openrouter.ai/api/v1");
  assert.equal(normalizeAnthropicBaseUrl("https://bigmodel.cn/api/anthropic"),"https://bigmodel.cn/api/anthropic/v1");
});

test("generateText：openai-responses 协议（如 magpie / OpenAI）正确传递 instructions、input 与档位映射",async()=>{
  let captured=null;
  const provider={
    providerId:"magpie",
    config:{
      api:{type:"openai-responses",baseUrl:"http://127.0.0.1:3425"},
      access:{type:"api-key",apiKey:"magpie-key"}
    }
  };
  const model={
    modelId:"bzs/group/gemini-4-carbon",
    config:{
      optionSpecs:{
        reasoningLevel:{values:["low","medium","high"],map:`{"reasoning":{"effort":reasoningLevel}}`},
        maxOutputTokens:{max:65536,map:`{"max_output_tokens":maxOutputTokens}`}
      }
    }
  };
  const result=await generateText({
    selection:{providerId:"magpie",modelId:"bzs/group/gemini-4-carbon",options:{reasoningLevel:"low"}},
    provider,model,
    messages:sampleMessages,
    maxOutputTokens:2048,timeoutMs:5000,
    fetchImpl:async(url,options)=>{
      captured={url,headers:options.headers,body:JSON.parse(options.body)};
      return {
        ok:true,status:200,
        headers:new Headers({"content-type":"application/json"}),
        text:async()=>JSON.stringify({
          status:"completed",
          output:[
            {type:"reasoning",summary:[{text:"thinking"}]},
            {type:"message",role:"assistant",content:[{type:"output_text",text:"```json\n{\"action\":\"rename\",\"title\":\"🧩 模型目录｜支持全量模型\",\"reason\":\"主线明确\"}\n```"}]}
          ],
          usage:{input_tokens:120,output_tokens:35}
        })
      };
    }
  });
  assert.equal(captured.url,"http://127.0.0.1:3425/responses");
  assert.equal(captured.headers.authorization,"Bearer magpie-key");
  assert.equal(captured.body.model,"bzs/group/gemini-4-carbon");
  assert.equal(captured.body.instructions,"只输出 JSON");
  assert.deepEqual(captured.body.input,[{role:"user",content:"{\"current_title\":\"旧标题\"}"}]);
  assert.deepEqual(captured.body.reasoning,{effort:"low"});
  assert.equal(captured.body.max_output_tokens,8192);
  assert.equal(JSON.parse(result.text).title,"🧩 模型目录｜支持全量模型");
  assert.equal(result.finishReason,"stop");
  assert.deepEqual(result.usage,{input_tokens:120,output_tokens:35});
});

test("generateText：openai-chat-completions 协议正确拼装 /chat/completions 与 SSE 流响应解析",async()=>{
  let captured=null;
  const provider={
    providerId:"siliconflow",
    config:{
      api:{type:"openai-chat-completions",baseUrl:"https://api.siliconflow.cn/v1"},
      access:{type:"api-key",apiKey:"sf-key"}
    }
  };
  const model={
    modelId:"deepseek-ai/DeepSeek-V4-Flash",
    config:{
      optionSpecs:{
        reasoningLevel:{values:["disabled","high"],map:`{"enable_thinking":reasoningLevel != "disabled"}`},
        maxOutputTokens:{max:4096,map:`{"max_tokens":maxOutputTokens}`}
      }
    }
  };
  const sseBody=[
    `data: {"choices":[{"delta":{"content":"{\\"ok\\":"}}]}`,
    `data: {"choices":[{"delta":{"content":"true}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":4}}`,
    `data: [DONE]`
  ].join("\n\n");
  const result=await generateText({
    selection:{providerId:"siliconflow",modelId:"deepseek-ai/DeepSeek-V4-Flash",options:{reasoningLevel:"disabled"}},
    provider,model,
    messages:sampleMessages,
    maxOutputTokens:2048,timeoutMs:5000,
    fetchImpl:async(url,options)=>{
      captured={url,body:JSON.parse(options.body)};
      return {ok:true,status:200,headers:new Headers({"content-type":"text/event-stream"}),text:async()=>sseBody};
    }
  });
  assert.equal(captured.url,"https://api.siliconflow.cn/v1/chat/completions");
  assert.equal(captured.body.enable_thinking,false);
  assert.equal(captured.body.max_tokens,2048,"关闭思考时不额外抬高 token 上限");
  assert.equal(result.text,"{\"ok\":true}");
  assert.equal(result.finishReason,"stop");
  assert.deepEqual(result.usage,{input_tokens:10,output_tokens:4});
});

test("generateText：anthropic-messages 提取顶层 system 并在 OpenRouter 自动注入归属头",async()=>{
  let captured=null;
  const provider={
    providerId:"my-or",
    config:{
      api:{type:"anthropic-messages",baseUrl:"https://openrouter.ai/api"},
      access:{type:"api-key",apiKey:"or-key"}
    }
  };
  const model={
    modelId:"anthropic/claude-sonnet-5.5",
    config:{
      optionSpecs:{
        reasoningLevel:{values:["low","high"],map:`{"thinking":{"type":"adaptive"},"output_config":{"effort":reasoningLevel}}`},
        maxOutputTokens:{max:128000,map:`{"max_tokens":maxOutputTokens}`}
      }
    }
  };
  const result=await generateText({
    selection:{providerId:"my-or",modelId:"anthropic/claude-sonnet-5.5",options:{reasoningLevel:"low"}},
    provider,model,
    messages:sampleMessages,
    maxOutputTokens:2048,timeoutMs:5000,
    fetchImpl:async(url,options)=>{
      captured={url,headers:options.headers,body:JSON.parse(options.body)};
      return {
        ok:true,status:200,
        headers:new Headers({"content-type":"application/json"}),
        text:async()=>JSON.stringify({
          content:[{type:"thinking",thinking:"..."},{type:"text",text:"{\"ok\":1}"}],
          stop_reason:"end_turn",
          usage:{input_tokens:8,output_tokens:3}
        })
      };
    }
  });
  assert.equal(captured.url,"https://openrouter.ai/api/v1/messages");
  assert.equal(captured.headers["X-OpenRouter-Title"],"ZCode");
  assert.equal(captured.body.system,"只输出 JSON");
  assert.deepEqual(captured.body.messages,[{role:"user",content:"{\"current_title\":\"旧标题\"}"}]);
  assert.equal(result.text,"{\"ok\":1}");
});

test("mintProjectToken 与 verifyProviderAuth：官方账号铸 token 与 API Key 渠道鉴权校验",async()=>{
  const calls=[];
  const minted=await mintProjectToken({
    loginToken:"login-jwt",
    accountType:"bigmodel",
    now:()=>1000,
    fetchImpl:async url=>{
      calls.push(url);
      if(url.endsWith("/getCustomerInfo")) {
        return {ok:true,status:200,text:async()=>JSON.stringify({data:{organizations:[{organizationId:"org1",organizationName:"默认组织",projects:[{projectId:"proj1",projectName:"默认项目",projectType:1}]}]}})};
      }
      if(url.endsWith("/api_keys")) {
        return {ok:true,status:200,text:async()=>JSON.stringify({data:[{name:"zcode-api-key",apiKey:"ak_1"}]})};
      }
      return {ok:true,status:200,text:async()=>JSON.stringify({data:{enabled:true,accessToken:"short-jwt",expiresIn:3600}})};
    }
  });
  assert.equal(minted.token,"short-jwt");
  assert.equal(minted.expiresAt,1000+3600*1000);
  assert.equal(calls.length,3);

  const authOk=await verifyProviderAuth({
    provider:{providerId:"magpie",config:{api:{type:"openai-responses",baseUrl:"http://127.0.0.1:3425"},access:{type:"api-key",apiKey:"k"}}}
  });
  assert.equal(authOk.ok,true);

  await assert.rejects(
    ()=>mintProjectToken({
      loginToken:"bad-jwt",
      accountType:"bigmodel",
      fetchImpl:async()=>({ok:true,status:200,text:async()=>JSON.stringify({code:401,success:false,msg:"令牌已过期或验证不正确"})})
    }),
    {reasonCode:"credentials_invalid"}
  );
});
