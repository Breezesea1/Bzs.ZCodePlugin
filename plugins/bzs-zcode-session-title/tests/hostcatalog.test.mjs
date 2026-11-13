import test from "node:test";
import assert from "node:assert/strict";
import {createCipheriv,createHash,randomBytes} from "node:crypto";
import {mkdtemp,mkdir,writeFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {loadHostCatalog,evaluateOptionMap,applyOptionSpecs,decryptCredentialValue,credentialSecret} from "../hostcatalog.mjs";

function encryptForTest(plain,env) {
  const iv=randomBytes(12);
  const key=createHash("sha256").update(credentialSecret(env)).digest();
  const cipher=createCipheriv("aes-256-gcm",key,iv);
  const ct=Buffer.concat([cipher.update(plain,"utf8"),cipher.final()]);
  return `enc:v1:${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ct.toString("base64url")}`;
}

async function makeV2Sandbox() {
  const dir=await mkdtemp(join(tmpdir(),"bzs-hostcat-"));
  const runtimeDir=join(dir,"runtime","provider","test");
  await mkdir(runtimeDir,{recursive:true});
  return {
    dir,
    builtinPath:join(runtimeDir,"zcode-builtin.json"),
    personalPath:join(dir,"provider_config.json"),
    credentialsPath:join(dir,"credentials.json"),
    settingPath:join(dir,"setting.json"),
    cleanup:()=>rm(dir,{recursive:true,force:true})
  };
}

const sampleBuiltin={
  schemaVersion:1,
  revision:43,
  config:{
    providerConfigRules:{
      templateRules:[
        {
          templateId:"openrouter",
          templateNameMap:{"zh-CN":"OpenRouter"},
          config:{
            access:{type:"api-key"},
            api:{type:"anthropic-messages",baseUrl:"https://openrouter.ai/api"},
            builtinModelIds:["anthropic/claude-sonnet-5.5","deepseek/deepseek-v4-flash"]
          }
        }
      ],
      providerRules:[
        {
          providerId:"account:bigmodel-individual-coding-plan",
          providerName:"BigModel Individual Coding Plan",
          config:{
            group:"bigmodel-family",
            access:{type:"zhipu-account",mode:"individual-coding-plan",accountType:"bigmodel"},
            api:{type:"anthropic-messages",baseUrl:"https://open.bigmodel.cn/api/anthropic"},
            builtinModelIds:["GLM-5.3","GLM-5.3-Flash"]
          }
        },
        {
          providerId:"account:bigmodel-team-coding-plan",
          providerName:"BigModel Team Coding Plan",
          config:{
            group:"bigmodel-family",
            access:{type:"zhipu-account",mode:"team-coding-plan",accountType:"bigmodel"},
            api:{type:"anthropic-messages",baseUrl:"https://open.bigmodel.cn/api/anthropic"},
            builtinModelIds:["GLM-5.3"]
          }
        },
        {
          providerId:"account:bigmodel-offpeak-idle-plan",
          providerName:"Idle",
          config:{
            group:"bigmodel-family",
            access:{type:"zhipu-account",mode:"off-peak",accountType:"bigmodel"},
            api:{type:"anthropic-messages",baseUrl:"https://zcode.z.ai/api/v1/off-peak/anthropic"},
            builtinModelIds:["GLM-5.3"]
          }
        }
      ]
    },
    modelConfigRules:{
      modelRules:[
        {modelMatch:".*",config:{enabled:true,optionSpecs:{reasoningLevel:{values:["disabled","enabled"],map:"{}"},maxOutputTokens:{max:128000}}}},
        {modelMatch:".*glm-5\\.3.*",config:{optionSpecs:{reasoningLevel:{values:["low","high","max"]}}}},
        {modelMatch:".*claude-sonnet-5\\.5.*",config:{optionSpecs:{reasoningLevel:{values:["low","medium","high"]}}}}
      ],
      modelApiRules:[
        {
          modelMatch:".*",
          apiTypeMatch:"anthropic-messages",
          config:{optionSpecs:{reasoningLevel:{map:`reasoningLevel == "disabled" ? {"thinking":{"type":"disabled"}} : {"thinking":{"type":"adaptive"},"output_config":{"effort":reasoningLevel}}`},maxOutputTokens:{map:`{"max_tokens": maxOutputTokens}`}}}
        },
        {
          modelMatch:".*",
          apiTypeMatch:"openai-responses",
          config:{optionSpecs:{reasoningLevel:{map:`{"reasoning":{"effort":reasoningLevel == "disabled" ? "none" : reasoningLevel}}`},maxOutputTokens:{map:`{"max_output_tokens": maxOutputTokens}`}}}
        }
      ],
      providerSiteRules:[],
      templateModelRules:[],
      builtinProviderModelRules:[]
    }
  }
};

test("loadHostCatalog：还原个人自定义渠道、模板派生渠道与已登录官方账号渠道",async()=>{
  const sb=await makeV2Sandbox();
  const env={
    BZS_TITLE_ZCODE_V2_DIR:sb.dir,
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE:sb.builtinPath,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE:sb.personalPath,
    BZS_TITLE_CREDENTIALS:sb.credentialsPath,
    ZCODE_CREDENTIAL_SECRET:"unit-secret"
  };
  await writeFile(sb.builtinPath,JSON.stringify(sampleBuiltin));
  await writeFile(sb.credentialsPath,JSON.stringify({
    "oauth:bigmodel:access_token":encryptForTest("jwt-token",env)
  }));
  await writeFile(sb.personalPath,JSON.stringify({
    schemaVersion:1,
    config:{
      providerOrder:["magpie","my-openrouter"],
      providerConfigRules:{
        providerRules:[
          {
            providerId:"magpie",
            providerName:"magpie",
            enabled:true,
            config:{
              access:{type:"api-key",apiKey:"magpie-secret"},
              api:{type:"openai-responses",baseUrl:"http://127.0.0.1:3425"},
              personalModelIds:["bzs/auto/gpt-6.1-sol","bzs/qnaigc/qiniu/conatus-free","bzs/disabled-model"],
              modelOrder:["bzs/qnaigc/qiniu/conatus-free","bzs/auto/gpt-6.1-sol"]
            }
          },
          {
            providerId:"my-openrouter",
            templateId:"openrouter",
            enabled:true,
            config:{
              access:{type:"api-key",apiKey:"sk-or-123"},
              personalModelIds:["google/gemini-3.8-flash"]
            }
          },
          {
            providerId:"disabled-provider",
            enabled:false,
            config:{
              access:{type:"api-key",apiKey:"sk-nope"},
              api:{type:"openai-chat-completions",baseUrl:"https://example.com/v1"},
              personalModelIds:["m1"]
            }
          }
        ]
      },
      modelConfigRules:{
        providerModelRules:[
          {providerId:"magpie",modelId:"bzs/auto/gpt-6.1-sol",config:{optionSpecs:{reasoningLevel:{values:["low","medium","high","xhigh","max","ultra"]}}}},
          {providerId:"magpie",modelId:"bzs/disabled-model",config:{enabled:false}}
        ],
        manualProviderModelRules:[]
      }
    }
  }));

  const catalog=await loadHostCatalog({env});
  assert.deepEqual(catalog.providers.map(p=>p.providerId),[
    "account:bigmodel-individual-coding-plan",
    "magpie",
    "my-openrouter"
  ],"off-peak、未选中的 team-coding-plan 与 disabled-provider 均不应进入可用目录");

  const magpie=catalog.providers.find(p=>p.providerId==="magpie");
  assert.deepEqual(magpie.models.map(m=>m.modelId),["bzs/qnaigc/qiniu/conatus-free","bzs/auto/gpt-6.1-sol"],"遵守 modelOrder 且剔除已禁用模型");
  assert.deepEqual(magpie.models[0].config.optionSpecs.reasoningLevel.values,["disabled","enabled"]);
  assert.deepEqual(magpie.models[1].config.optionSpecs.reasoningLevel.values,["low","medium","high","xhigh","max","ultra"]);

  const or=catalog.providers.find(p=>p.providerId==="my-openrouter");
  assert.equal(or.providerName,"OpenRouter");
  assert.equal(or.config.api.baseUrl,"https://openrouter.ai/api");
  assert.deepEqual(or.models.map(m=>m.modelId),["anthropic/claude-sonnet-5.5","deepseek/deepseek-v4-flash","google/gemini-3.8-flash"]);
  assert.deepEqual(or.models[0].config.optionSpecs.reasoningLevel.values,["low","medium","high"]);

  await sb.cleanup();
});

test("loadHostCatalog：provider_config.json 缺失时兼容旧版 v2/config.json 自定义渠道",async()=>{
  const sb=await makeV2Sandbox();
  const env={
    BZS_TITLE_ZCODE_V2_DIR:sb.dir,
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE:join(sb.dir,"missing-builtin.json"),
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE:join(sb.dir,"missing-personal.json"),
    BZS_TITLE_CREDENTIALS:join(sb.dir,"missing-creds.json")
  };
  await writeFile(join(sb.dir,"config.json"),JSON.stringify({
    provider:{
      "bzs-chat":{
        name:"BZS Chat",
        kind:"openai-compatible",
        enabled:true,
        source:"custom",
        options:{baseURL:"https://cpa.example.com/v1",apiKey:"sk-custom"},
        models:{"deepseek-v4-flash":{reasoning:{variants:["off","low","high","max"]}}}
      }
    }
  }));
  const catalog=await loadHostCatalog({env});
  assert.equal(catalog.providers.length,1);
  assert.equal(catalog.providers[0].providerId,"bzs-chat");
  assert.equal(catalog.providers[0].config.api.type,"openai-chat-completions");
  assert.deepEqual(catalog.providers[0].models[0].config.optionSpecs.reasoningLevel.values,["off","low","high","max"]);
  await sb.cleanup();
});

test("evaluateOptionMap 与 applyOptionSpecs：正确求值三元、逻辑运算与 JSON 合并补丁",()=>{
  const map=`reasoningLevel == "disabled" || reasoningLevel == "none"
    ? {"thinking":{"type":"disabled"}}
    : {"thinking":{"type":"adaptive"},"output_config":{"effort":reasoningLevel == "enabled" ? "high" : reasoningLevel}}`;
  assert.deepEqual(evaluateOptionMap(map,"reasoningLevel","disabled"),{thinking:{type:"disabled"}});
  assert.deepEqual(evaluateOptionMap(map,"reasoningLevel","enabled"),{thinking:{type:"adaptive"},output_config:{effort:"high"}});
  assert.deepEqual(evaluateOptionMap(map,"reasoningLevel","ultra"),{thinking:{type:"adaptive"},output_config:{effort:"ultra"}});

  const body=applyOptionSpecs(
    {model:"m1",input:[{role:"user",content:"hi"}]},
    {
      reasoningLevel:{map:`{"reasoning":{"effort":reasoningLevel}}`},
      maxOutputTokens:{map:`{"max_output_tokens":maxOutputTokens}`}
    },
    {reasoningLevel:"medium",maxOutputTokens:4096}
  );
  assert.deepEqual(body,{
    model:"m1",
    input:[{role:"user",content:"hi"}],
    reasoning:{effort:"medium"},
    max_output_tokens:4096
  });
});

test("decryptCredentialValue：enc:v1 加解密往返一致",()=>{
  const env={ZCODE_CREDENTIAL_SECRET:"k1"};
  const enc=encryptForTest("secret-jwt",env);
  assert.equal(decryptCredentialValue(enc,env),"secret-jwt");
  assert.throws(()=>decryptCredentialValue(enc,{ZCODE_CREDENTIAL_SECRET:"wrong"}),{reasonCode:"credentials_decrypt_failed"});
});

test("decryptCredentialValue：支持宿主新版 enc:v2:os / enc:v2:env 密文且拒绝未知 enc: 前缀",()=>{
  const rawKey=randomBytes(32);
  const fp=createHash("sha256").update(rawKey).digest("hex").slice(0,24);
  const iv=randomBytes(12);
  const cipher=createCipheriv("aes-256-gcm",rawKey,iv);
  const ct=Buffer.concat([cipher.update("v2-os-jwt","utf8"),cipher.final()]);
  const sealed=`${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ct.toString("base64url")}`;
  const v2Os=`enc:v2:os:${fp}:${sealed}`;

  assert.equal(
    decryptCredentialValue(v2Os,{},{
      credentialsPath:"D:\\v2\\credentials.json",
      osKeyReader:()=>rawKey.toString("base64url")
    }),
    "v2-os-jwt"
  );

  const envSecret="managed-secret-at-least-32-bytes-long!!";
  const envKey=createHash("sha256").update(envSecret).digest();
  const envFp=createHash("sha256").update(envKey).digest("hex").slice(0,24);
  const c2=createCipheriv("aes-256-gcm",envKey,iv);
  const ct2=Buffer.concat([c2.update("v2-env-jwt","utf8"),c2.final()]);
  const v2Env=`enc:v2:env:${envFp}:${iv.toString("base64url")}.${c2.getAuthTag().toString("base64url")}.${ct2.toString("base64url")}`;
  assert.equal(decryptCredentialValue(v2Env,{ZCODE_CREDENTIAL_SECRET:envSecret}),"v2-env-jwt");

  assert.throws(()=>decryptCredentialValue("enc:v99:unknown",{}),{reasonCode:"credentials_invalid"});
});
