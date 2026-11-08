// 会话持久层：与宿主一致以 SQLite 会话库/任务索引为权威。
// session 行提供标题与归属目录，message/part 行重建有效对话轮；
// revert 记录回退点，快照只反映用户实际看到的对话状态。
// 用 Node 22+ 内置 node:sqlite 只读打开，无外部依赖。
import {DatabaseSync} from "node:sqlite";
import {win32} from "node:path";
import {createHash} from "node:crypto";
import {getConversationMessageProjectionPolicy} from "./vendor/projection.js";

export const SESSION_ID_RE=/^sess(?:ion)?_[A-Za-z0-9_-]+$/;

const samePath=(a,b)=>win32.normalize(String(a??"")).toLowerCase()===win32.normalize(String(b??"")).toLowerCase();

// 只读连接缓存：worker 短命，同一库会查多次（行存在性、会话行、历史）。
const readers=new Map();
function readOnly(dbPath) {
  let db=readers.get(dbPath);
  if(!db) {
    db=new DatabaseSync(dbPath,{readOnly:true});
    db.exec("PRAGMA busy_timeout = 3000");
    readers.set(dbPath,db);
  }
  return db;
}

export function closeHistoryConnections() {
  for(const db of readers.values()) {
    try {db.close();}catch {}
  }
  readers.clear();
}

// 只读查询 → 行数组。SQL 一律参数化，杜绝拼接注入。
export function queryAll(dbPath,sql,params=[]) {
  return readOnly(dbPath).prepare(sql).all(...params);
}

// 会话归属列：宿主新库写 path，旧库只有 directory；coalesce 两者取一。
const SESSION_DIRECTORY_SQL=`coalesce(path,directory)`;

function readSessionRow(dbPath,sessionId) {
  const rows=queryAll(dbPath,`SELECT id,${SESSION_DIRECTORY_SQL} AS directory,title,revert,title_source AS titleSource FROM session WHERE id=?`,[sessionId]);
  if(!rows.length)throw new Error("会话不在指定 SQLite 库中");
  const row=rows[0];
  return {id:row.id,directory:row.directory,title:row.title,revert:row.revert?JSON.parse(row.revert):null,titleSource:row.titleSource};
}

export function sessionExistsInSessionDb({dbPath,sessionId}) {
  return queryAll(dbPath,"SELECT 1 AS ok FROM session WHERE id=? LIMIT 1",[sessionId]).length>0;
}

// 索引行每次现查：rename 前后 title/archived 会变化，不能缓存。
// cli_title 是外部进程的写入位：宿主镜像 title 列有延迟窗口，读回校验须读自己的写入。
export function loadIndexRow({dbPath,sessionId}) {
  try {
    return queryAll(dbPath,"SELECT task_id,workspace_path,title,title_overridden AS titleOverridden,cli_title AS cliTitle,cli_title_source AS cliTitleSource,archived,deleted,task_status AS taskStatus FROM tasks WHERE task_id=?",[sessionId])[0]??null;
  } catch {return null;}
}

// UI 同款标题解析：title_overridden=1（用户手动改名）以 title 为准，否则用 cli_title 写入位
export function displayTitleOf(row) {
  if(!row)return null;
  if(row.titleOverridden===1||row.titleOverridden===true)return row.title;
  return row.cliTitle??row.title;
}

export function readHistory({dbPath,sessionId,workspacePath}) {
  if(!SESSION_ID_RE.test(sessionId??""))throw new Error("无效会话 ID");
  const session=readSessionRow(dbPath,sessionId);
  // 会话归属以库中记录为权威：Stop 事件的 cwd 是窗口当前目录，可能已被切换
  if(workspacePath&&!samePath(session.directory,workspacePath))throw new Error("会话数据库的工作区不匹配");
  // 单次查询取齐两表。消息按时间排序，部件在所属消息内按 sequence 排序
  //（ID 是随机串，不能当顺序）。同一连接内用事务保证两次读取一致。
  const db=readOnly(dbPath);
  db.exec("BEGIN");
  try {
    const rows=db.prepare(`
      SELECT 'message' kind,id,'' message_id,sequence IS NULL missing_seq,sequence,time_created,json_remove(data,'$.contextSnapshot') data FROM message WHERE session_id=?
      UNION ALL SELECT 'part',id,message_id,sequence IS NULL,sequence,time_created,CASE WHEN json_extract(data,'$.type')='text' THEN data ELSE json_object('type',json_extract(data,'$.type'),'synthetic',json_extract(data,'$.synthetic'),'metadata',json_extract(data,'$.metadata')) END FROM part WHERE session_id=?
      ORDER BY kind,message_id,missing_seq,sequence,time_created,id
    `).all(sessionId,sessionId);
    db.exec("COMMIT");
    return buildHistory(session,rows,sessionId);
  }catch(error) {
    try {db.exec("ROLLBACK");}catch {}
    throw error;
  }
}

function buildHistory(session,rows,sessionId) {
  const parts=new Map();
  for(const row of rows.filter(r=>r.kind==="part")) {
    const list=parts.get(row.message_id)??[];
    list.push({...JSON.parse(row.data),id:row.id,sessionID:sessionId,messageID:row.message_id});
    parts.set(row.message_id,list);
  }
  return {session,messages:rows.filter(r=>r.kind==="message").map(r=>({
    info:{...JSON.parse(r.data),id:r.id,sessionID:sessionId},
    parts:parts.get(r.id)??[]
  }))};
}

// 重建有效对话轮：按投影策略筛出真实用户输入与可见助手回复，
// 应用 revert 回退，输出用于总结的整段上下文与漂移指纹。
export function conversationSnapshot({session,messages}) {
  let active=messages;
  const revert=session.revert;
  if(revert?.targetMessageID) {
    const ids=new Map(messages.map(m=>[m.info.id,m]));
    const targetIndex=messages.findIndex(m=>m.info.id===revert.targetMessageID);
    if(!revert.keptMessageIDs&&targetIndex<0)throw new Error("回退目标不在持久化历史中");
    const kept=revert.keptMessageIDs?revert.keptMessageIDs.map(id=>ids.get(id)).filter(Boolean):messages.slice(0,targetIndex);
    const createdIndex=messages.findIndex(m=>m.info.id===revert.createdMessageID);
    active=createdIndex>=0?[...kept,...messages.slice(createdIndex)]:kept;
  }
  const users=[],byUser=new Map();
  for(const message of active) {
    const policy=getConversationMessageProjectionPolicy(message);
    const text=message.parts.filter(p=>p.type==="text"&&!p.ignored&&!p.synthetic).map(p=>p.text).join("").trim();
    if(message.info.role==="user"&&policy==="realUserInput") {
      const turn={id:message.info.id,user:text,assistant:[]};users.push(turn);byUser.set(turn.id,turn);
    } else if(message.info.role==="assistant"&&policy==="visibleAssistant"&&text) {
      const parent=message.info.parentID;
      // 回退生成的提示消息不是用户看到的内容
      if(parent===revert?.createdMessageID&&text.endsWith("Rewound conversation to before message "+revert.targetMessageID+"."))continue;
      const turn=byUser.get(parent);
      if(turn)turn.assistant.push(text);
    }
  }
  const effective=users.filter(t=>t.user);
  const fingerprint=createHash("sha256").update(JSON.stringify({policy:1,activeIds:active.map(m=>m.info.id)})).digest("hex");
  return {turns:effective,fingerprint,latestUserId:effective.at(-1)?.id};
}

// 提取送入总结模型的上下文：原始目标 + 最近 N 轮（每轮截断，控制 token）。
export function summarizeContext({turns=[],projectHint,maxTurns=6,userChars=2000,assistantChars=3000}={}) {
  const clamp=(v,max)=>typeof v==="string"?v.slice(0,max):"";
  const selected=turns.slice(-maxTurns);
  return {
    project_hint:projectHint,
    original_goal:clamp(turns[0]?.user??"",800),
    turn_count:turns.length,
    turns:selected.map(t=>({
      user:clamp(t.user,userChars),
      assistant:clamp((t.assistant??[]).join("\n"),assistantChars)
    }))
  };
}
