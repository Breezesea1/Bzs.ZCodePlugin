// 任务索引直写层：tasks-index.sqlite 的 cli_title 列是宿主为 CLI/外部进程预留的写入位。
// UI 标题解析为 title_overridden=1 ? title : cli_title；title_source='custom' 表示用户手动
// 改名，宿主会据此置 title_overridden（锁定语义与插件状态机的 locked 一致）。
// 写库经 node:sqlite 短事务 + busy_timeout，与宿主（同为 SQLite WAL 写方）并存。
import {DatabaseSync} from "node:sqlite";
import {existsSync} from "node:fs";

let connection=null;

function connect(dbPath) {
  if(connection)return connection;
  if(!dbPath||!existsSync(dbPath)) {
    throw Object.assign(new Error("任务索引不存在："+dbPath),{reasonCode:"index_db_missing"});
  }
  connection=new DatabaseSync(dbPath);
  connection.exec("PRAGMA busy_timeout = 3000");
  return connection;
}

export function close() {
  try {connection?.close();}catch {}
  connection=null;
}

export function resetConnectionForTest() {connection=null;}

function workspaceKeyOf(workspacePath) {
  // 实库证据：tasks.workspace_key 存原始工作区路径字符串（getWorkspaceKey 语义，非哈希）
  return String(workspacePath??"").trim();
}

// 读取任务行（与宿主 rowToMeta 同投影）。找不到行返回 null。
export function loadTaskRow({dbPath,sessionId,workspacePath}) {
  const row=connect(dbPath).prepare(
    "SELECT task_id,title,title_overridden,cli_title,cli_title_source,handoff_pending,archived,deleted,task_status FROM tasks WHERE workspace_key=? AND task_id=?"
  ).get(workspaceKeyOf(workspacePath),sessionId);
  return row??null;
}

// 改名（同步写 title 与 cli_title 位）。返回是否命中并写入。
// 首次写 cli_title_source='custom' 后，宿主 applyCliFacts 会把 title_overridden 置 1；
// UI 查询按 title_overridden=1 ? title : cli_title 取值，因此二次及后续改名需同步写两列，
// 并仅在 handoff_pending bit2=1（UI 有未交割手动改名）或有效标题已漂移时让位回滚。
export function renameTask({dbPath,sessionId,workspacePath,title,expectedTitle}) {
  const key=workspaceKeyOf(workspacePath);
  const db=connect(dbPath);
  db.exec("BEGIN IMMEDIATE");
  try {
    const row=db.prepare("SELECT title,cli_title,title_overridden,cli_title_source,handoff_pending FROM tasks WHERE workspace_key=? AND task_id=?").get(key,sessionId);
    if(!row) {db.exec("ROLLBACK");return false;}
    if(((row.handoff_pending??0)&2)!==0) {db.exec("ROLLBACK");return false;}
    const currentTitle=row.title_overridden===1?row.title:(row.cli_title??row.title);
    if(expectedTitle!==undefined&&currentTitle!==expectedTitle) {db.exec("ROLLBACK");return false;}
    db.prepare(
      `UPDATE tasks SET
        title=?,
        cli_title=?,
        cli_title_source='custom',
        cli_updated_at=?
      WHERE workspace_key=? AND task_id=?`
    ).run(title,title,Date.now(),key,sessionId);
    db.exec("COMMIT");
    return true;
  }catch(error) {
    try {db.exec("ROLLBACK");}catch {}
    throw error;
  }
}

// 供 doctor/status 汇报索引可达性
export function indexReachable(dbPath) {
  try {connect(dbPath).prepare("SELECT 1 FROM tasks LIMIT 1").get();return true;}
  catch {return false;}
}
