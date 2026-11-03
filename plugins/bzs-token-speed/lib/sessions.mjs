// Session resolution: which session is "the current one" for a caller.
// Strategy: explicit id > directory match ordered by freshest model traffic >
// any interactive session with traffic in the active window > nothing.
import * as db from "./db.mjs";

const ACTIVE_WINDOW_MS = 30 * 60 * 1000;
const CANDIDATE_LIMIT = 12;

// ZCODE_PROJECT_DIR arrives in posix form under Git Bash hosts; the session
// table stores windows backslash form. Normalize both sides for comparison.
export function toWinPath(p) {
  return p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

export function resolveCurrent({ sessionId, workingDir } = {}) {
  if (sessionId) {
    const row = db.findSessionById(sessionId);
    if (row) return { ...row, resolvedBy: "explicit" };
  }

  const directories = workingDir ? [...new Set([workingDir, toWinPath(workingDir)])] : [];

  let candidates =
    directories.length > 0
      ? db.findInteractiveSessions({ directories, limit: CANDIDATE_LIMIT })
      : [];
  let resolvedBy = workingDir ? "directory+recency" : null;

  if (candidates.length === 0) {
    candidates = db.findInteractiveSessions({
      sinceMs: Date.now() - ACTIVE_WINDOW_MS,
      limit: CANDIDATE_LIMIT,
    });
    resolvedBy = "global-recency";
  }
  if (candidates.length === 0) return { id: null, resolvedBy: "none" };

  const latest = db.latestTrafficBySession(candidates.map((c) => c.id))[0];
  const winner = latest
    ? candidates.find((c) => c.id === latest.session_id)
    : candidates[0];
  return {
    ...winner,
    resolvedBy: resolvedBy ?? "global-recency",
    lastActivityAt: latest?.last_ms ?? winner.time_updated,
  };
}
