// 会话持久层：与宿主一致以 SQLite 会话库/任务索引为权威。
// session 行提供标题与归属目录，message/part 行重建有效对话轮；
// revert 记录回退点，快照只反映用户实际看到的对话状态。
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {win32} from "node:path";
import {createHash} from "node:crypto";
import {getConversationMessageProjectionPolicy} from "./vendor/projection.js";

export const SESSION_ID_RE=/^sess(?:ion)?_[A-Za-z0-9_-]+$/;

const samePath=(a,b)=>win32.normalize(String(a??"")).toLowerCase()===win32.normalize(String(b??"")).toLowerCase();

// sqlite3 CLI 只读查询 → JSON 行。空结果输出空串，返回 []。
export async function queryJson(dbPath,sql,sqliteBin="sqlite3") {
  const {stdout}=await promisify(execFile)(sqliteBin,["-readonly","-json",dbPath,sql],{encoding:"utf8",windowsHide:true,maxBuffer:256*1024*1024});
  return stdout.trim()?JSON.parse(stdout):[];
}

// 会话归属列：宿主新库写 path，旧库只有 directory；coalesce 两者取一。
const SESSION_DIRECTORY_SQL=`coalesce(path,directory)`;

async function readSessionRow(dbPath,sessionId,sqliteBin) {
  const rows=await queryJson(dbPath,`SELECT id,${SESSION_DIRECTORY_SQL} AS directory,title,revert,title_source AS titleSource FROM session WHERE id='${sessionId}';`,sqliteBin);
  if(!rows.length)throw new Error("会话不在指定 SQLite 库中");
  const row=rows[0];
  return {id:row.id,directory:row.directory,title:row.title,revert:row.revert?JSON.parse(row.revert):null,titleSource:row.titleSource};
}

export async function sessionExistsInSessionDb({dbPath,sessionId,sqliteBin}) {
  return (await queryJson(dbPath,`SELECT 1 AS ok FROM session WHERE id='${sessionId}' LIMIT 1;`,sqliteBin)).length>0;
}

// 索引行每次现查：rename 前后 title/archived 会变化，不能缓存。
// cli_title 是外部进程的写入位：宿主镜像 title 列有延迟窗口，读回校验须读自己的写入。
export async function loadIndexRow({dbPath,sessionId,sqliteBin}) {
  try {return (await queryJson(dbPath,`SELECT task_id,workspace_path,title,title_overridden AS titleOverridden,cli_title AS cliTitle,cli_title_source AS cliTitleSource,archived,deleted,task_status AS taskStatus FROM tasks WHERE task_id='${sessionId}';`,sqliteBin))[0]??null;}
  catch {return null;}
}

// UI 同款标题解析：title_overridden=1（用户手动改名）以 title 为准，否则用 cli_title 写入位
export function displayTitleOf(row) {
  if(!row)return null;
  if(row.titleOverridden===1||row.titleOverridden===true)return row.title;
  return row.cliTitle??row.title;
}

export async function readHistory({dbPath,sessionId,workspacePath,sqliteBin="sqlite3"}) {
  if(!SESSION_ID_RE.test(sessionId??""))throw new Error("无效会话 ID");
  const session=await readSessionRow(dbPath,sessionId,sqliteBin);
  // 会话归属以库中记录为权威：Stop 事件的 cwd 是窗口当前目录，可能已被切换
  if(workspacePath&&!samePath(session.directory,workspacePath))throw new Error("会话数据库的工作区不匹配");
  // 单次只读查询取齐两表；大历史下行数可能很多，放宽输出缓冲。
  // 消息按时间排序，部件在所属消息内按 sequence 排序（ID 是随机串，不能当顺序）。
  const quoted="'"+sessionId+"'";
  const sql=[
    "PRAGMA query_only=ON; BEGIN;",
    "SELECT 'message' kind,id,'' message_id,sequence IS NULL missing_seq,sequence,time_created,json_remove(data,'$.contextSnapshot') data FROM message WHERE session_id="+quoted,
    "UNION ALL SELECT 'part',id,message_id,sequence IS NULL,sequence,time_created,CASE WHEN json_extract(data,'$.type')='text' THEN data ELSE json_object('type',json_extract(data,'$.type'),'synthetic',json_extract(data,'$.synthetic'),'metadata',json_extract(data,'$.metadata')) END FROM part WHERE session_id="+quoted,
    "ORDER BY kind,message_id,missing_seq,sequence,time_created,id; COMMIT;"
  ].join("\n");
  const rows=await queryJson(dbPath,sql,sqliteBin);
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
