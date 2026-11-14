// Metrics: pure computation from raw model_usage and live part rows.
// No IO, no wall clocks — `now` is injected so results stay deterministic and testable.

const RECENT_WINDOW_MS = 10 * 60 * 1000;
const STREAMING_HOLD_MS = 2500;
const MAX_CHART_SAMPLES = 32;
const LIVE_STALE_MS = 90 * 1000;

const CJK_RE = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/g;

// Lightweight token estimator used ONLY for in-flight streaming feedback before
// provider-reported model_usage row is committed at step completion.
export function estimateTextTokens(text) {
  if (!text) return 0;
  const cjk = (text.match(CJK_RE) ?? []).length;
  const rest = text.length - cjk;
  return cjk * 0.65 + rest * 0.27;
}

// Classify and measure a single completed model_usage row without falling for:
// 1) Hidden/opaque thinking before `first_token_at` (where `first_token_at` only
//    stamps the first visible/tool token after tens of seconds of reasoning,
//    causing `output_tokens / (completed_at - first_token_at)` to spike >1000 tok/s).
// 2) Buffered single-packet flushes (e.g. proxy or tool-call JSON emitted in <750ms
//    after multi-second generation).
export function measureRequest(row) {
  const out = row.output_tokens ?? 0;
  const rsn = Math.min(out, Math.max(0, row.reasoning_tokens ?? 0));
  const vis = out - rsn;
  const dur =
    row.duration_ms ??
    (row.completed_at && row.started_at ? row.completed_at - row.started_at : 0);

  if (out <= 0 || dur < 80) return null;

  const hasFt =
    row.first_token_at != null &&
    row.completed_at != null &&
    row.completed_at > row.first_token_at;
  const ttft =
    hasFt && row.started_at != null
      ? Math.max(0, row.first_token_at - row.started_at)
      : row.time_to_first_token_ms ?? null;
  const dec = hasFt ? row.completed_at - row.first_token_at : null;

  const hiddenReasoning =
    hasFt &&
    rsn > 0 &&
    ttft != null &&
    ttft > 2500 &&
    (dec < 800 ||
      ttft > 8000 ||
      (ttft / dur > 0.3 && dur / dec > 1.45));

  if (hasFt && !hiddenReasoning) {
    const bufferedFlush =
      dec < 750 &&
      dur > 2500 &&
      dec / dur < 0.2 &&
      out / (dec / 1000) > 250;
    if (!bufferedFlush && dec >= 120) {
      return {
        rateTokens: out,
        rateMs: dec,
        tokPerSec: out / (dec / 1000),
        mode: "stream",
        pureTtftMs: ttft,
        firstVisibleMs: ttft,
      };
    }
  }

  if (hiddenReasoning) {
    // Post-thinking visible text genuinely streamed (not a single-chunk tool JSON flush)
    const visStreamed = vis >= 24 && dec >= 800 && vis / (dec / 1000) <= 350;
    if (visStreamed) {
      return {
        rateTokens: vis,
        rateMs: dec,
        tokPerSec: vis / (dec / 1000),
        mode: "vis-stream",
        pureTtftMs: null,
        firstVisibleMs: ttft,
      };
    }
  }

  return {
    rateTokens: out,
    rateMs: dur,
    tokPerSec: out / (dur / 1000),
    mode: "e2e",
    pureTtftMs: null,
    firstVisibleMs: ttft,
  };
}

// Weighted average = ΣrateTokens / ΣrateMs, never the arithmetic mean of rates.
function weightedTokPerSec(list) {
  const tokens = list.reduce((a, s) => a + s.rateTokens, 0);
  const ms = list.reduce((a, s) => a + s.genMs, 0);
  return ms > 0 ? tokens / (ms / 1000) : null;
}

export function computeMetrics(rows, now) {
  const samples = [];
  const models = {};
  const bySource = {};
  const totals = {
    outputTokens: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
  };
  let ttftSum = 0;
  let ttftCount = 0;
  let firstVisSum = 0;
  let firstVisCount = 0;

  for (const r of rows) {
    totals.outputTokens += r.output_tokens ?? 0;
    totals.inputTokens += r.input_tokens ?? 0;
    totals.cacheReadTokens += r.cache_read_input_tokens ?? 0;
    totals.cacheCreationTokens += r.cache_creation_input_tokens ?? 0;
    totals.reasoningTokens += r.reasoning_tokens ?? 0;
    if (r.model_id) models[r.model_id] = (models[r.model_id] ?? 0) + 1;
    if (r.query_source) bySource[r.query_source] = (bySource[r.query_source] ?? 0) + 1;

    const m = measureRequest(r);
    if (!m) continue;

    if (m.pureTtftMs != null) {
      ttftSum += m.pureTtftMs;
      ttftCount += 1;
    }
    if (m.firstVisibleMs != null) {
      firstVisSum += m.firstVisibleMs;
      firstVisCount += 1;
    }

    samples.push({
      ts: r.completed_at,
      tokPerSec: m.tokPerSec,
      rateTokens: m.rateTokens,
      outputTokens: r.output_tokens ?? 0,
      reasoningTokens: r.reasoning_tokens ?? 0,
      genMs: m.rateMs,
      durationMs: r.duration_ms ?? m.rateMs,
      mode: m.mode,
      model: r.model_id ?? null,
      finishReason: r.finish_reason ?? null,
    });
  }

  const recent = samples.filter((s) => s.ts >= now - RECENT_WINDOW_MS);
  const lastAt = rows[0]?.completed_at ?? null;
  totals.freshInputTokens = Math.max(
    0,
    totals.inputTokens - totals.cacheReadTokens - totals.cacheCreationTokens
  );
  const cacheHitRatio =
    totals.inputTokens > 0
      ? Math.min(1, Math.max(0, totals.cacheReadTokens / totals.inputTokens))
      : null;

  return {
    requestCount: rows.length,
    hasData: rows.length > 0,
    lastRequestAt: lastAt,
    secondsSinceLastRequest: lastAt ? Math.max(0, (now - lastAt) / 1000) : null,
    streaming: lastAt != null && now - lastAt >= 0 && now - lastAt < STREAMING_HOLD_MS,
    speed: {
      latest: samples[0] ?? null,
      recent10m: weightedTokPerSec(recent),
      recentCount: recent.length,
      overall: weightedTokPerSec(samples),
      peak: samples.reduce(
        (a, s) => (a === null || s.tokPerSec > a.tokPerSec ? s : a),
        null
      ),
      samples: samples.slice(0, MAX_CHART_SAMPLES).reverse(), // chronological, newest last
    },
    ttft: {
      avgMs: ttftCount ? ttftSum / ttftCount : null,
      count: ttftCount,
      avgFirstVisibleMs: firstVisCount ? firstVisSum / firstVisCount : null,
      firstVisibleCount: firstVisCount,
    },
    cacheHitRatio,
    totals,
    models,
    bySource,
  };
}

function safeJson(raw) {
  if (!raw || typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Inspect the session's newest message & parts to detect real-time in-flight
// thinking / streaming / tool execution before model_usage commits on completion.
export function computeLiveActivity(bundle, lastCompletedAt, now) {
  const idle = {
    active: false,
    phase: "idle",
    liveTokPerSec: null,
    liveTokens: 0,
    elapsedMs: null,
  };
  if (!bundle?.message) return idle;

  const { message, parts = [] } = bundle;
  const msgData = safeJson(message.data);
  const role = msgData?.role ?? null;

  if (role === "user") {
    const createdAt = message.time_created ?? 0;
    const isNewer = !lastCompletedAt || createdAt > lastCompletedAt - 250;
    if (isNewer && now - createdAt >= 0 && now - createdAt < LIVE_STALE_MS) {
      return {
        active: true,
        phase: "thinking",
        liveTokPerSec: null,
        liveTokens: 0,
        elapsedMs: Math.max(0, now - createdAt),
      };
    }
    return idle;
  }

  if (msgData?.time?.completed) return idle;

  let stepParts = [];
  let lastFinishReason = null;
  let lastFinishAt = 0;

  for (const row of parts) {
    const data = safeJson(row.data);
    if (!data) continue;
    if (data.type === "step-finish") {
      stepParts = [];
      lastFinishReason = data.reason ?? null;
      lastFinishAt = row.time_updated ?? row.time_created ?? 0;
      continue;
    }
    stepParts.push({ row, data });
  }

  if (stepParts.length === 0) {
    if (
      lastFinishReason === "tool-calls" &&
      lastFinishAt > 0 &&
      now - lastFinishAt < 5000
    ) {
      return {
        active: true,
        phase: "thinking",
        liveTokPerSec: null,
        liveTokens: 0,
        elapsedMs: Math.max(0, now - lastFinishAt),
      };
    }
    return idle;
  }

  const stepStartAt =
    stepParts[0].row.time_created ?? message.time_created ?? now;
  let latestUpdateAt = message.time_updated ?? stepStartAt;
  for (const { row } of stepParts) {
    const t = row.time_updated ?? row.time_created ?? 0;
    if (t > latestUpdateAt) latestUpdateAt = t;
  }
  if (now - latestUpdateAt > LIVE_STALE_MS) return idle;

  // Running tool call means the LLM step already finished and we are waiting on a tool.
  for (const { data } of stepParts) {
    if (
      data.type === "tool" &&
      (data.state?.status === "running" || data.state?.status === "pending")
    ) {
      return {
        active: true,
        phase: "tool",
        liveTokPerSec: null,
        liveTokens: 0,
        elapsedMs: Math.max(0, now - stepStartAt),
      };
    }
  }

  let estTokens = 0;
  let hasVisibleText = false;
  let firstStreamAt = null;
  let lastStreamAt = null;

  for (const { row, data } of stepParts) {
    if (data.type === "reasoning" && data.text) {
      estTokens += estimateTextTokens(data.text);
      const c = row.time_created ?? null;
      const u = row.time_updated ?? c;
      if (c != null && (firstStreamAt == null || c < firstStreamAt)) firstStreamAt = c;
      if (u != null && (lastStreamAt == null || u > lastStreamAt)) lastStreamAt = u;
    } else if (data.type === "text" && !data.synthetic && data.text) {
      hasVisibleText = true;
      estTokens += estimateTextTokens(data.text);
      const c = row.time_created ?? null;
      const u = row.time_updated ?? c;
      if (c != null && (firstStreamAt == null || c < firstStreamAt)) firstStreamAt = c;
      if (u != null && (lastStreamAt == null || u > lastStreamAt)) lastStreamAt = u;
    }
  }

  const phase = hasVisibleText ? "streaming" : "thinking";
  let liveTokPerSec = null;
  if (
    estTokens >= 8 &&
    firstStreamAt != null &&
    lastStreamAt != null &&
    lastStreamAt - firstStreamAt >= 300 &&
    now - lastStreamAt < 10_000
  ) {
    const effectiveEnd = Math.min(now, lastStreamAt + 1500);
    const windowMs = Math.max(300, effectiveEnd - firstStreamAt);
    liveTokPerSec = estTokens / (windowMs / 1000);
  }

  return {
    active: true,
    phase,
    liveTokPerSec,
    liveTokens: Math.round(estTokens),
    elapsedMs: Math.max(0, now - stepStartAt),
  };
}

export function summarize(snapshot) {
  const m = snapshot.metrics;
  const live = snapshot.live ?? {
    active: false,
    phase: "idle",
    liveTokPerSec: null,
    liveTokens: 0,
    elapsedMs: null,
  };
  if (!m?.hasData && !live.active) return null;
  const s = m?.speed;
  return {
    sessionId: snapshot.session.id,
    streaming: Boolean(live.active || m?.streaming),
    phase: live.active ? live.phase : m?.streaming ? "streaming" : "idle",
    liveTokPerSec: live.liveTokPerSec,
    liveTokens: live.liveTokens,
    liveElapsedMs: live.elapsedMs,
    secondsSinceLastRequest: m?.secondsSinceLastRequest ?? null,
    latestTokPerSec: s?.latest?.tokPerSec ?? null,
    latestMode: s?.latest?.mode ?? null,
    latestTokens: s?.latest?.outputTokens ?? null,
    latestReasoningTokens: s?.latest?.reasoningTokens ?? null,
    latestGenMs: s?.latest?.genMs ?? null,
    latestModel: s?.latest?.model ?? null,
    recent10m: s?.recent10m ?? null,
    recentCount: s?.recentCount ?? 0,
    overall: s?.overall ?? null,
    peak: s?.peak?.tokPerSec ?? null,
    avgTtftMs: m?.ttft.avgMs ?? m?.ttft.avgFirstVisibleMs ?? null,
    pureTtftMs: m?.ttft.avgMs ?? null,
    avgFirstVisibleMs: m?.ttft.avgFirstVisibleMs ?? null,
    cacheHitRatio: m?.cacheHitRatio ?? null,
    requestCount: m?.requestCount ?? 0,
    outputTokens: m?.totals.outputTokens ?? 0,
    reasoningTokens: m?.totals.reasoningTokens ?? 0,
    cacheReadTokens: m?.totals.cacheReadTokens ?? 0,
    inputTokens: m?.totals.inputTokens ?? 0,
    samples: s?.samples ?? [],
  };
}
