import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {resolveHostSelection,resolveSelection,normalizeHostModelId} from "../hostcatalog.mjs";

test("normalizeHostModelId：剥 magpie 承载前缀并小写",()=>{
  assert.equal(normalizeHostModelId("bzs/group/glm-5.3-flash"),"glm-5.3-flash");
  assert.equal(normalizeHostModelId("GLM-5.3-Flash"),"glm-5.3-flash");
  assert.equal(normalizeHostModelId("MiniMax-M3.1-Flash"),"minimax-m3.1-flash");
  assert.equal(normalizeHostModelId("glm-5.3"),"glm-5.3");
});

function setupDb(rows) {
  const dir=mkdtempSync(join(tmpdir(),"bzs-hostcatalog-"));
  const dbPath=join(dir,"db.sqlite");
  const db=new DatabaseSync(dbPath);
  db.exec("CREATE TABLE message (id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT)");
  let i=0;
  for(const data of rows)db.prepare("INSERT INTO message VALUES (?,?,?,?)").run(`m${i++}`,data.session_id??="sess_t",data.time,data.data);
  db.close();
  return dbPath;
}

const assistantMsg=(providerId,modelId)=>JSON.stringify({role:"assistant",providerId,modelId});
const userMsg=()=>JSON.stringify({role:"user"});

test("resolveHostSelection：取最新 assistant 消息的 provider/model 并归家族",()=>{
  const dbPath=setupDb([
    {time:1,data:userMsg()},
    {time:2,data:assistantMsg("magpie","GLM-5.3-Flash")},
    {time:3,data:assistantMsg("magpie","bzs/group/glm-5.3-flash")}
  ]);
  const r=resolveHostSelection({dbPath,sessionId:"sess_t"});
  assert.equal(r.status,"ok");
  assert.equal(r.selection.providerId,"bigmodel");
  assert.equal(r.selection.modelId,"glm-5.3-flash");
  assert.equal(r.selection.options.reasoningLevel,"low");
  assert.deepEqual(r.source,{providerId:"magpie",modelId:"bzs/group/glm-5.3-flash"});
});

test("resolveHostSelection：magpie+MiniMax 模型归 minimax 家族",()=>{
  const dbPath=setupDb([{time:1,data:assistantMsg("magpie","MiniMax-M3.1-Flash")}]);
  const r=resolveHostSelection({dbPath,sessionId:"sess_t"});
  assert.equal(r.selection.providerId,"minimax");
  assert.equal(r.selection.modelId,"minimax-m3.1-flash");
});

test("resolveHostSelection：无 assistant 消息 → no_host_model",()=>{
  const dbPath=setupDb([{time:1,data:userMsg()}]);
  const r=resolveHostSelection({dbPath,sessionId:"sess_t"});
  assert.equal(r.status,"no_host_model");
  assert.equal(r.selection,null);
});

test("resolveHostSelection：未知 provider → host_family_unknown 带原因",()=>{
  const dbPath=setupDb([{time:1,data:assistantMsg("openai","gpt-x")}]);
  const r=resolveHostSelection({dbPath,sessionId:"sess_t"});
  assert.equal(r.status,"host_family_unknown");
});

test("resolveHostSelection：残缺/坏行被跳过，无可用品 → no_host_model",()=>{
  const dbPath=setupDb([{time:1,data:JSON.stringify({role:"assistant",modelId:"M"})}]);
  assert.equal(resolveHostSelection({dbPath,sessionId:"sess_t"}).status,"no_host_model");
  const dbPath2=setupDb([{time:1,data:"{broken"}]);
  assert.equal(resolveHostSelection({dbPath:dbPath2,sessionId:"sess_t"}).status,"no_host_model");
});

test("resolveHostSelection：坏行后的好行仍可用",()=>{
  const dbPath=setupDb([
    {time:1,data:"{broken"},
    {time:2,data:assistantMsg("magpie","GLM-5.3")}
  ]);
  const r=resolveHostSelection({dbPath,sessionId:"sess_t"});
  assert.equal(r.status,"ok");
  assert.equal(r.selection.modelId,"glm-5.3");
});

const fixedConfig={sessionDb:"unused",model:{source:"fixed"},selection:{providerId:"bigmodel",modelId:"GLM-5.3-Flash",options:{reasoningLevel:"medium"}}};

test("resolveSelection：fixed 模式不读库，直接用配置",()=>{
  const r=resolveSelection({config:fixedConfig,sessionId:"sess_any"});
  assert.equal(r.source,"fixed");
  assert.equal(r.selection.options.reasoningLevel,"medium");
});

test("resolveSelection：host-follow 成功时用宿主模型",()=>{
  const dbPath=setupDb([{time:1,data:assistantMsg("magpie","GLM-5.3")}]);
  const r=resolveSelection({config:{...fixedConfig,sessionDb:dbPath,model:{source:"host-follow"}},sessionId:"sess_t"});
  assert.equal(r.source,"host");
  assert.equal(r.selection.modelId,"glm-5.3");
  assert.equal(r.selection.options.reasoningLevel,"low");
});

test("resolveSelection：host 命中带显式 passthrough 标记，fixed/回落不带",()=>{
  const dbPath=setupDb([{time:1,data:assistantMsg("magpie","GLM-5.3")}]);
  const host=resolveSelection({config:{...fixedConfig,sessionDb:dbPath,model:{source:"host-follow"}},sessionId:"sess_t"});
  assert.equal(host.selection.passthrough,true);
  const fixed=resolveSelection({config:fixedConfig,sessionId:"sess_any"});
  assert.equal(fixed.selection.passthrough,undefined);
  const fbDb=setupDb([{time:1,data:userMsg()}]);
  const fb=resolveSelection({config:{...fixedConfig,sessionDb:fbDb,model:{source:"host-follow"}},sessionId:"sess_t"});
  assert.equal(fb.selection.passthrough,undefined);
});

test("resolveSelection：host-follow 失败回落 fixed 并带原因",()=>{
  const dbPath=setupDb([{time:1,data:userMsg()}]);
  const r=resolveSelection({config:{...fixedConfig,sessionDb:dbPath,model:{source:"host-follow"}},sessionId:"sess_t"});
  assert.equal(r.source,"fixed-fallback");
  assert.equal(r.fallbackReason,"no_host_model");
  assert.deepEqual(r.selection,fixedConfig.selection);
});

test("resolveSelection：host-follow 无 fixed selection 时返回空 selection（调用方显式失败）",()=>{
  const dbPath=setupDb([{time:1,data:userMsg()}]);
  const r=resolveSelection({config:{sessionDb:dbPath,model:{source:"host-follow"}},sessionId:"sess_t"});
  assert.equal(r.source,"fixed-fallback");
  assert.equal(r.selection,null);
});
