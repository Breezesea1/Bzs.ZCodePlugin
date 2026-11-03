#!/usr/bin/env node
// ZCode Stop Hook 派发器：宿主 Stop 事件 → 静默校验 → 后台启动命名 worker。
// 约定（源码核实）：用户级 config.json 的 Stop hook 无信任门槛；async:true 后台执行
// 不阻塞对话；stop_hook_active=true 表示本轮由 Stop 续跑产生，跳过以防重复命名；
// stdout 不得以 { 开头，避免被宿主解析为 hook 控制 JSON。
import {spawn} from "node:child_process";
import {join,dirname} from "node:path";
import {homedir} from "node:os";
import {appendFile,mkdir} from "node:fs/promises";
import {fileURLToPath,pathToFileURL} from "node:url";
import {resolveDataDir} from "./config.mjs";
import {readJsonOptional} from "./fsutil.mjs";

const pluginRoot=dirname(fileURLToPath(import.meta.url));

export const WORKER_START_DELAY_MS=5000;

export async function dispatchStopEvent({payload,dataDir,pluginRoot,configPath,spawnWorker=defaultSpawnWorker,startDelayMs=WORKER_START_DELAY_MS}) {
  if(!payload||typeof payload!=="object")return{action:"ignored_invalid"};
  if(payload.stop_hook_active===true)return{action:"skipped_stale"};
  const sessionId=payload.session_id??payload.sessionId;
  const workspacePath=payload.workspace_path??payload.cwd;
  if(!/^sess(?:ion)?_[A-Za-z0-9_-]+$/.test(sessionId??"")||!workspacePath)return{action:"ignored_invalid"};
  // Stop 触发瞬间宿主仍在持久化 turn 边界与任务状态，立即读快照必然指纹漂移成 stale；
  // 让出收尾窗口后再派发，保证 worker 读到的基线与复查一致。
  if(startDelayMs>0)await new Promise(resolve=>setTimeout(resolve,startDelayMs));
  const args=["run","--apply"];
  if(configPath)args.push("--config",configPath);
  await spawnWorker({script:join(pluginRoot,"cli.mjs"),args,event:{session_id:sessionId,workspace_path:workspacePath},dataDir});
  return{action:"dispatched"};
}

function defaultSpawnWorker({script,args,event,dataDir}) {
  const child=spawn(process.execPath,[script,...args],{
    detached:true,stdio:["pipe","ignore","ignore"],windowsHide:true,
    env:{...process.env,BZS_TITLE_DATA:dataDir}
  });
  child.stdin.end(JSON.stringify(event));
  child.unref();
}

const isMain=process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href;
if(isMain) {
  let configPath=null;
  for(let i=2;i<process.argv.length;i++) {
    if(process.argv[i]==="--config"&&process.argv[i+1])configPath=process.argv[++i];
  }
  let raw="";
  for await(const chunk of process.stdin)raw+=chunk;
  let payload=null;
  try {payload=JSON.parse(raw);}catch {}
  // 派发前只读开关与 dataDir 两个键，完整校验由 worker 的 loadConfig 负责；
  // hook 进程要快进快出，不重复跑一遍配置验证。
  let supplied=null;
  if(configPath) {try {supplied=await readJsonOptional(configPath);}catch {supplied=null;}}
  const dataDir=configPath
    ?resolveDataDir(configPath,supplied??{},process.env)
    :(process.env.BZS_TITLE_DATA??join(homedir(),".zcode","bzs-zcode-session-title"));
  const logHook=async entry=>{
    try {
      await mkdir(dataDir,{recursive:true});
      await appendFile(join(dataDir,"hook.log.jsonl"),JSON.stringify({at:new Date().toISOString(),...entry})+"\n","utf8");
    }catch{}
  };
  try {
    let result;
    if(configPath&&payload?.stop_hook_active!==true&&supplied?.enabled===false)result={action:"disabled"};
    result??=await dispatchStopEvent({payload,dataDir,pluginRoot,configPath});
    // stdout 首字符不能是 "{"：宿主会把它当 hook 决策 JSON 解析
    console.log("bzs-zcode-session-title:",JSON.stringify(result));
    await logHook({event:payload?.hook_event_name??"Stop",action:result.action,sessionId:payload?.session_id??null,cwd:payload?.cwd??payload?.workspace_path??null,stopHookActive:payload?.stop_hook_active===true,error:null});
  } catch(error) {
    console.log("bzs-zcode-session-title: hook-error",error.message);
    await logHook({event:payload?.hook_event_name??"Stop",action:"error",sessionId:payload?.session_id??null,cwd:payload?.cwd??payload?.workspace_path??null,error:String(error.message).slice(0,200)});
  }
  process.exit(0);
}
