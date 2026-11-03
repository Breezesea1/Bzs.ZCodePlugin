// Service layer: the composition root for domain operations. Transport layers
// (MCP tools, loopback HTTP) call only the functions exported here.
import * as db from "./db.mjs";
import { resolveCurrent } from "./sessions.mjs";
import { computeMetrics, summarize } from "./metrics.mjs";

export function dbPath() {
  return db.dbFilePath();
}

function buildSnapshot(sessionId, now) {
  const metrics = sessionId ? computeMetrics(db.completedRequestsForSession(sessionId, 300), now) : null;
  return { metrics, summary: metrics ? summarize({ session: { id: sessionId }, metrics }) : null };
}

// One coherent answer to "how fast is the current session going".
export function currentSpeedSnapshot({ sessionId, workingDir } = {}) {
  const session = resolveCurrent({ sessionId, workingDir });
  const now = Date.now();
  return {
    now,
    session: {
      id: session.id,
      title: session.title ?? null,
      resolvedBy: session.resolvedBy,
      lastActivityAt: session.lastActivityAt ?? null,
    },
    db: db.dbFilePath(),
    ...buildSnapshot(session.id, now),
  };
}

export function sessionSpeedSnapshot({ sessionId } = {}) {
  const now = Date.now();
  const session = db.findSessionById(sessionId);
  return {
    now,
    session: session
      ? { id: session.id, title: session.title ?? null, resolvedBy: "explicit" }
      : { id: null, resolvedBy: "none" },
    db: db.dbFilePath(),
    ...buildSnapshot(sessionId, now),
  };
}

export function activeSessions({ windowMs = 60 * 60 * 1000 } = {}) {
  const now = Date.now();
  return db.sessionsWithTrafficSince(now - windowMs, 20).map((r) => ({
    sessionId: r.session_id,
    title: r.title,
    directory: r.directory,
    kind: r.task_type,
    lastActivityAt: r.last_ms,
    secondsIdle: (now - r.last_ms) / 1000,
    requests: r.requests,
    outputTokens: r.output_tokens,
  }));
}
