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

test("renameTask：首次改名后宿主置 title_overridden=1 仍允许插件二次改名，但遇到 handoff_pending bit2 让位",async()=>{
  const {mkdtemp,rm}=await import("node:fs/promises");
  const {tmpdir}=await import("node:os");
  const {join}=await import("node:path");
  const {DatabaseSync}=await import("node:sqlite");
  const {renameTask,loadTaskRow,close}=await import("../taskstore.mjs");

  const dir=await mkdtemp(join(tmpdir(),"bzs-taskstore-"));
  const dbPath=join(dir,"tasks-index.sqlite");
  const db=new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE tasks (
    workspace_key TEXT NOT NULL, workspace_path TEXT NOT NULL, task_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '', title_overridden INTEGER NOT NULL DEFAULT 0,
    cli_title TEXT, cli_title_source TEXT, cli_updated_at INTEGER,
    handoff_pending INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0, task_status TEXT,
    PRIMARY KEY (workspace_key, task_id)
  )`);
  db.prepare("INSERT INTO tasks (workspace_key,workspace_path,task_id,title,cli_title,cli_title_source) VALUES (?,?,?,?,?,?)")
    .run("D:\\w","D:\\w","sess_r1","初始标题","初始标题","generated");
  db.close();

  assert.equal(renameTask({dbPath,sessionId:"sess_r1",workspacePath:"D:\\w",title:"🧩 对象｜一轮标题",expectedTitle:"初始标题"}),true);
  // 模拟宿主 applyCliFacts 因 cli_title_source='custom' 将 title_overridden 置 1
  const db2=new DatabaseSync(dbPath);
  db2.prepare("UPDATE tasks SET title_overridden=1 WHERE task_id='sess_r1'").run();
  db2.close();

  assert.equal(renameTask({dbPath,sessionId:"sess_r1",workspacePath:"D:\\w",title:"🧩 对象｜二轮新标题",expectedTitle:"🧩 对象｜一轮标题"}),true);
  const updated=loadTaskRow({dbPath,sessionId:"sess_r1",workspacePath:"D:\\w"});
  assert.equal(updated.title,"🧩 对象｜二轮新标题");
  assert.equal(updated.cli_title,"🧩 对象｜二轮新标题");

  // 模拟 UI 刚发生未交割的手动改名（handoff_pending bit2=1）
  const db3=new DatabaseSync(dbPath);
  db3.prepare("UPDATE tasks SET title='用户手改',handoff_pending=2 WHERE task_id='sess_r1'").run();
  db3.close();
  assert.equal(renameTask({dbPath,sessionId:"sess_r1",workspacePath:"D:\\w",title:"🧩 对象｜三轮标题"}),false);

  close();
  await rm(dir,{recursive:true,force:true});
});
