import test from "node:test";
import assert from "node:assert/strict";
import {readHistory,conversationSnapshot,summarizeContext} from "../history.mjs";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";

const run=promisify(execFile);

// 构造与宿主同构的最小会话库：session/message/part 三表 + 投影所需字段
async function makeDb({turns,revert,title="旧标题",titleSource="first_input"}={}) {
  const dir=await mkdtemp(join(tmpdir(),"bzs-hist-"));
  const dbPath=join(dir,"db.sqlite");
  const q=s=>String(s).replace(/'/g,"''");
  const directory="D:"+String.fromCharCode(92)+"proj"+String.fromCharCode(92)+"demo";
  let sql=`
CREATE TABLE session (id text primary key,directory text,path text,title text not null,revert text,title_source text not null default 'first_input',time_created integer not null,time_updated integer not null);
CREATE TABLE message (id text primary key,session_id text not null,time_created integer not null,time_updated integer not null,data text not null,sequence integer);
CREATE TABLE part (id text primary key,message_id text not null,session_id text not null,time_created integer not null,time_updated integer not null,data text not null,sequence integer);
INSERT INTO session (id,directory,title,revert,title_source,time_created,time_updated)
  VALUES ('sess_test1','${q(directory)}','${q(title)}',${revert?`'${q(JSON.stringify(revert))}'`:"NULL"},'${titleSource}',1,1);
`;
  let t=0;
  for(let i=0;i<turns.length;i++) {
    const turn=turns[i],userId="msg_u"+i,assistantId="msg_a"+i;
    sql+=`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES ('${userId}','sess_test1',${t},${t},'{"id":"${userId}","role":"user","parentID":null,"semantics":{"origin":"real_user"}}');\n`;
    sql+=`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES ('p_u${i}','${userId}','sess_test1',${t},${t},'{"type":"text","text":${JSON.stringify(turn.user)}}');\n`;
    t++;
    if(turn.assistant) {
      sql+=`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES ('${assistantId}','sess_test1',${t},${t},'{"id":"${assistantId}","role":"assistant","parentID":"${userId}","semantics":{"kind":"assistant_response","uiVisibility":"visible","transcriptVisibility":"visible"}}');\n`;
      sql+=`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES ('p_a${i}','${assistantId}','sess_test1',${t},${t},'{"type":"text","text":${JSON.stringify(turn.assistant)}}');\n`;
      t++;
    }
  }
  await run("sqlite3",[dbPath,sql],{windowsHide:true});
  return {dbPath,cleanup:()=>rm(dir,{recursive:true,force:true})};
}

test("readHistory：读取会话标题与消息轮",async()=>{
  const {dbPath,cleanup}=await makeDb({turns:[{user:"帮我修一下登录"},{user:"好",assistant:"已修复"}]});
  const history=await readHistory({dbPath,sessionId:"sess_test1",workspacePath:"D:\\proj\\demo"});
  assert.equal(history.session.title,"旧标题");
  assert.equal(history.messages.length,3);
  await cleanup();
});

test("readHistory：无效会话 ID 与工作区不匹配时报错",async()=>{
  const {dbPath,cleanup}=await makeDb({turns:[{user:"hi"}]});
  await assert.rejects(()=>readHistory({dbPath,sessionId:"bad id",workspacePath:"D:\\proj\\demo"}),/无效会话/);
  await assert.rejects(()=>readHistory({dbPath,sessionId:"sess_test1",workspacePath:"E:\\other"}),/工作区不匹配/);
  await cleanup();
});

test("readHistory：会话不存在时报错",async()=>{
  const {dbPath,cleanup}=await makeDb({turns:[{user:"hi"}]});
  await assert.rejects(()=>readHistory({dbPath,sessionId:"sess_missing",workspacePath:"D:\\proj\\demo"}),/不在指定/);
  await cleanup();
});

test("conversationSnapshot：提取真实用户轮与助手回复",async()=>{
  const {dbPath,cleanup}=await makeDb({turns:[{user:"第一轮需求",assistant:"第一轮答复"},{user:"第二轮需求"}]});
  const history=await readHistory({dbPath,sessionId:"sess_test1",workspacePath:"D:\\proj\\demo"});
  const snapshot=conversationSnapshot(history);
  assert.equal(snapshot.turns.length,2);
  assert.equal(snapshot.turns[0].assistant[0],"第一轮答复");
  assert.match(snapshot.turns[1].user,/第二轮需求/);
  assert.ok(/^[0-9a-f]{64}$/.test(snapshot.fingerprint));
  await cleanup();
});

test("summarizeContext：截断轮数与字符",async()=>{
  const turns=Array.from({length:12},(_,i)=>({id:"m"+i,user:"需求"+i+"。".repeat(3000),assistant:[]}));
  const context=summarizeContext({turns,projectHint:"demo",maxTurns:3,userChars:100});
  assert.equal(context.turns.length,3);
  assert.equal(context.turns[0].user.length,100);
  assert.equal(context.original_goal.length,800);
  assert.equal(context.project_hint,"demo");
  assert.equal(context.turn_count,12);
});
