// Metrics: pure computation from raw model_usage rows. No IO, no clocks —
// `now` is injected so results are deterministic and testable.

const RECENT_WINDOW_MS = 10 * 60 * 1000;
const STREAMING_WINDOW_MS = 3000;
const MIN_SAMPLE_WINDOW_MS = 50;
const MAX_SAMPLE_ROWS = 300;
const MAX_CHART_SAMPLES = 60;

// Decode window: first token → completion. Missing first_token_at (tiny
// responses, retried attempts) falls back to the full request duration.
function decodeWindowMs(row) {
  if (row.first_token_at && row.completed_at > row.first_token_at) {
    return row.completed_at - row.first_token_at;
  }
  return row.duration_ms ?? 0;
}

// Weighted average = Σtokens / Σtime, never the mean of per-request rates.
function weightedTokPerSec(list) {
  const tokens = list.reduce((a, s) => a + s.outputTokens, 0);
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

  for (const r of rows) {
    totals.outputTokens += r.output_tokens;
    totals.inputTokens += r.input_tokens;
    totals.cacheReadTokens += r.cache_read_input_tokens;
    totals.cacheCreationTokens += r.cache_creation_input_tokens;
    totals.reasoningTokens += r.reasoning_tokens;
    models[r.model_id] = (models[r.model_id] ?? 0) + 1;
    bySource[r.query_source] = (bySource[r.query_source] ?? 0) + 1;
    if (r.first_token_at && r.started_at) {
      ttftSum += r.first_token_at - r.started_at;
      ttftCount += 1;
    }
    const genMs = decodeWindowMs(r);
    if (r.output_tokens > 0 && genMs >= MIN_SAMPLE_WINDOW_MS) {
      samples.push({
        ts: r.completed_at,
        tokPerSec: r.output_tokens / (genMs / 1000),
        outputTokens: r.output_tokens,
        genMs,
        model: r.model_id,
      });
    }
  }

  const recent = samples.filter((s) => s.ts >= now - RECENT_WINDOW_MS);
  const lastAt = rows[0]?.completed_at ?? null;
  // effective non-cached input actually paid for
  totals.freshInputTokens = Math.max(
    0,
    totals.inputTokens - totals.cacheReadTokens - totals.cacheCreationTokens
  );

  return {
    requestCount: rows.length,
    hasData: rows.length > 0,
    lastRequestAt: lastAt,
    secondsSinceLastRequest: lastAt ? (now - lastAt) / 1000 : null,
    streaming: lastAt != null && now - lastAt < STREAMING_WINDOW_MS,
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
    ttft: { avgMs: ttftCount ? ttftSum / ttftCount : null, count: ttftCount },
    totals,
    models,
    bySource,
  };
}

export function summarize(snapshot) {
  const m = snapshot.metrics;
  if (!m?.hasData) return null;
  const s = m.speed;
  return {
    sessionId: snapshot.session.id,
    streaming: m.streaming,
    secondsSinceLastRequest: m.secondsSinceLastRequest,
    latestTokPerSec: s.latest?.tokPerSec ?? null,
    latestTokens: s.latest?.outputTokens ?? null,
    latestGenMs: s.latest?.genMs ?? null,
    latestModel: s.latest?.model ?? null,
    recent10m: s.recent10m,
    recentCount: s.recentCount,
    overall: s.overall,
    peak: s.peak?.tokPerSec ?? null,
    avgTtftMs: m.ttft.avgMs,
    requestCount: m.requestCount,
    outputTokens: m.totals.outputTokens,
    cacheReadTokens: m.totals.cacheReadTokens,
    inputTokens: m.totals.inputTokens,
    samples: s.samples,
  };
}
