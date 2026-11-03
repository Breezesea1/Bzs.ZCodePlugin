// Storage layer: the only module that knows about db.sqlite's location and schema.
// A single read-only connection is shared process-wide; under WAL it observes
// fresh commits without blocking the writer (ZCode's own CLI process).
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DB_CANDIDATES = () =>
  [
    process.env.ZCODE_SESSION_DB_PATH,
    process.env.ZCODE_SESSION_DB,
    join(homedir(), ".zcode", "cli", "db", "db.sqlite"),
  ].filter(Boolean);

let connection = null;

export function dbFilePath() {
  return DB_CANDIDATES().find((p) => existsSync(p)) ?? null;
}

export function connect() {
  if (connection) return connection;
  const path = dbFilePath();
  if (!path) {
    const err = new Error(
      `session db not found (tried: ${DB_CANDIDATES().join(", ")})`
    );
    err.code = "DB_NOT_FOUND";
    throw err;
  }
  connection = new DatabaseSync(path, {
    readOnly: true,
    enableForeignKeyConstraints: false,
  });
  connection.exec("PRAGMA busy_timeout = 3000");
  return connection;
}

export function close() {
  connection?.close();
  connection = null;
}

// ---- queries ---------------------------------------------------------------
// Each query returns plain rows; no business logic lives here.

export function findSessionById(id) {
  return (
    connect()
      .prepare(
        `SELECT id, title, directory, path, task_type, time_created, time_updated
         FROM session WHERE id = ? AND time_deleted IS NULL`
      )
      .get(id) ?? null
  );
}

export function findInteractiveSessions({ directories, sinceMs, limit }) {
  const db = connect();
  if (directories && directories.length > 0) {
    const placeholders = directories.map(() => "?").join(", ");
    return db
      .prepare(
        `SELECT id, title, directory, path, task_type, time_created, time_updated
         FROM session
         WHERE task_type = 'interactive' AND time_deleted IS NULL
           AND (directory IN (${placeholders}) OR path IN (${placeholders}))
         ORDER BY time_updated DESC LIMIT ${Number(limit)}`
      )
      .all(...directories);
  }
  return db
    .prepare(
      `SELECT id, title, directory, path, task_type, time_created, time_updated
       FROM session
       WHERE task_type = 'interactive' AND time_deleted IS NULL AND time_updated > ?
       ORDER BY time_updated DESC LIMIT ${Number(limit)}`
    )
    .all(sinceMs);
}

export function latestTrafficBySession(sessionIds) {
  if (sessionIds.length === 0) return [];
  const placeholders = sessionIds.map(() => "?").join(", ");
  return connect()
    .prepare(
      `SELECT session_id, MAX(COALESCE(completed_at, started_at)) AS last_ms
       FROM model_usage WHERE session_id IN (${placeholders})
       GROUP BY session_id ORDER BY last_ms DESC`
    )
    .all(...sessionIds);
}

export function completedRequestsForSession(sessionId, limit) {
  return connect()
    .prepare(
      `SELECT started_at, first_token_at, completed_at, duration_ms,
              output_tokens, input_tokens, cache_read_input_tokens,
              cache_creation_input_tokens, reasoning_tokens,
              model_id, query_source, finish_reason
       FROM model_usage
       WHERE session_id = ? AND status = 'completed'
       ORDER BY completed_at DESC LIMIT ?`
    )
    .all(sessionId, limit);
}

export function sessionsWithTrafficSince(sinceMs, limit) {
  return connect()
    .prepare(
      `SELECT mu.session_id, s.title, s.directory, s.task_type,
              MAX(COALESCE(mu.completed_at, mu.started_at)) AS last_ms,
              COUNT(*) AS requests,
              SUM(mu.output_tokens) AS output_tokens
       FROM model_usage mu JOIN session s ON s.id = mu.session_id
       WHERE COALESCE(mu.completed_at, mu.started_at) > ? AND s.time_deleted IS NULL
       GROUP BY mu.session_id
       ORDER BY last_ms DESC LIMIT ?`
    )
    .all(sinceMs, limit);
}
