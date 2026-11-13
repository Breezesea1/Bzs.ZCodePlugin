#!/usr/bin/env node
// 命名 worker CLI。hook 派发的 "run" 命令从 stdin 读会话事件完成一次命名；
// 其余命令供技能（setup/configuration/control/debug）与排障使用。
// 本文件只做进程事务：argv/stdin 解析、配置装载、worker 互斥、日志与退出码；
// 命令实现在 commands.mjs，数据访问在 history.mjs，模型调用在 backend.mjs/modelcall.mjs。
import {homedir} from "node:os";
import {join,resolve} from "node:path";
import {open,mkdir,appendFile,unlink} from "node:fs/promises";
import {createBackend} from "./backend.mjs";
import {loadConfig,resolveDataDir} from "./config.mjs";
import {executeCommand,loadPrompt} from "./commands.mjs";
import {writeJsonAtomic} from "./fsutil.mjs";

const COMMANDS=["run","doctor","models","probe","status","enable","disable","lock","unlock","policy"];
// 只有 run 写会话状态并与并发命名互斥；管理命令随时可跑，不被 worker 阻塞。
const LOCKED_COMMANDS=new Set(["run"]);
// 需要会话数据/标题策略的命令才构造 backend；status/enable/disable/probe/models 纯本地或自含连接。
const BACKEND_COMMANDS=new Set(["run","doctor","lock","unlock","policy"]);
// 管理命令没有真实会话上下文：models 允许 stdin {}，用占位会话 + cwd 兜底附着。
const PLACEHOLDER_SESSION="sess_cli_manage";

function usage() {
  console.log("用法：node cli.mjs run [--apply] [--config 文件]\n      node cli.mjs doctor|models|probe|status|enable|disable [--config 文件]\n      node cli.mjs lock|unlock|policy [--config 文件]（固定/解除固定/查询会话标题策略；先校验目标会话存在）\nstdin JSON：session_id、workspace_path（或 cwd）、可选 user_message_id；models/status/enable/disable 可传 {}。\n直连本机数据层与模型端点，无需网关、无需外部服务。");
}

function parseArgs(argv) {
  const command=argv[0];
  if(!COMMANDS.includes(command))throw new Error("未知命令");
  let configPath=null,apply=false;
  for(let i=1;i<argv.length;i++) {
    if(argv[i]==="--apply"&&command==="run")apply=true;
    else if(argv[i]==="--config"&&argv[i+1])configPath=resolve(argv[++i]);
    else throw new Error("未知参数");
  }
  return {command,configPath,apply};
}

async function readStdinJson() {
  if(process.stdin.isTTY)return {};
  let raw="";
  for await(const chunk of process.stdin)raw+=chunk;
  if(!raw.trim())return {};
  try {return JSON.parse(raw);}
  catch {throw new Error("stdin JSON 无效");}
}

async function acquireLease(leasePath) {
  let lease;
  try {lease=await open(leasePath,"wx");}
  catch(error) {
    if(error.code==="EEXIST")throw new Error("busy：另一个命名进程持有共享远控连接");
    throw error;
  }
  try {await lease.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));}
  finally {await lease.close();}
}

const args=process.argv.slice(2);
if(args.includes("--help")||!args.length) {
  usage();
} else {
  const startedAt=Date.now();
  let leasePath=null,backend=null;
  try {
    const {command,configPath:explicitConfigPath,apply}=parseArgs(args);
    const event=await readStdinJson();
    if(command==="models") {
      // 查询宿主模型目录不依赖本插件是否已完成 config.json 初始化
      const result=await executeCommand({command:"models",env:process.env});
      console.log(JSON.stringify(result));
    } else {
      const configPath=explicitConfigPath??join(process.env.ZCODE_PLUGIN_DATA??process.env.BZS_TITLE_DATA??join(homedir(),".zcode","bzs-zcode-session-title"),"config.json");
      const loaded=await loadConfig(configPath,{allowDisabled:command!=="run"});
      // run 命令对未配置/暂停只报状态不报错，方便 hook 静默退出
      if(loaded.error) {
        if(command==="run"&&(loaded.error==="disabled"||loaded.error==="not_configured")) {
          console.log(JSON.stringify({status:loaded.error==="disabled"?"disabled":"not_configured"}));
        } else throw new Error(loaded.message);
      } else {
        const config=loaded.config;
        const dataDir=resolveDataDir(configPath,config,process.env);
        await mkdir(dataDir,{recursive:true});
        const statePath=join(dataDir,(event.session_id??"unknown")+".json");
        if(BACKEND_COMMANDS.has(command)) {
          const sessionEvent={
            ...event,
            session_id:event.session_id??PLACEHOLDER_SESSION,
            workspace_path:event.workspace_path??event.cwd??process.cwd()
          };
          backend=createBackend({
            event:sessionEvent,config,
            prompt:await loadPrompt(import.meta.dirname,config),
            saveState:async state=>{await writeJsonAtomic(statePath,state);}});
        }
        if(LOCKED_COMMANDS.has(command)) {
          // worker 互斥：避免并发命名互相踩踏状态文件与改名
          leasePath=join(dataDir,"worker.lock");
          await acquireLease(leasePath);
        }
        const result=await executeCommand({command,event,config,configPath,dataDir,backend,apply,statePath});
        console.log(JSON.stringify(result));
        if(command==="run")await appendFile(join(dataDir,"usage.jsonl"),JSON.stringify({at:new Date().toISOString(),...result})+"\n","utf8").catch(()=>{});
        await appendFile(join(dataDir,"runner.log.jsonl"),JSON.stringify({at:new Date().toISOString(),command,sessionId:event.session_id??null,status:result.status,reasonCode:result.reasonCode??null,title:result.title??null,durationMs:Date.now()-startedAt})+"\n","utf8").catch(()=>{});
      }
    }
  } catch(error) {
    const failure={status:"failed",error:String(error.message).slice(0,300)};
    if(error.reasonCode)failure.reasonCode=error.reasonCode;
    if(error.stage)failure.stage=error.stage;
    console.log(JSON.stringify(failure));
    process.exitCode=1;
  } finally {
    if(leasePath)await unlink(leasePath).catch(()=>{});
    backend?.close();
  }
}
