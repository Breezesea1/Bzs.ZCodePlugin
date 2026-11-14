import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  measureRequest,
  computeMetrics,
  computeLiveActivity,
  summarize,
} from "../lib/metrics.mjs";
import {
  injectSnippet,
  stripInjection,
  hasInjection,
  extractInjectedMeta,
  computeChipVersionTag,
} from "../scripts/lib/target.mjs";
import * as dbModule from "../lib/db.mjs";
import { currentSpeedSnapshot, sessionSpeedSnapshot } from "../lib/service.mjs";
import { handle as handleMcp } from "../server/mcp.mjs";

describe("metrics: measureRequest & computeMetrics", () => {
  it("measures standard streaming decode accurately", () => {
    const row = {
      started_at: 1000,
      first_token_at: 2200,
      completed_at: 7200,
      duration_ms: 6200,
      output_tokens: 400,
      reasoning_tokens: 0,
      input_tokens: 10000,
      cache_read_input_tokens: 8000,
      cache_creation_input_tokens: 0,
      model_id: "GLM-5.3-Flash",
      finish_reason: "stop",
    };
    const m = measureRequest(row);
    assert.equal(m.mode, "stream");
    assert.equal(m.pureTtftMs, 1200);
    assert.ok(Math.abs(m.tokPerSec - 80) < 0.01);
  });

  it("keeps streamed reasoning models (e.g. deepseek-flash) in stream mode with full output_tokens", () => {
    const row = {
      started_at: 0,
      first_token_at: 3800,
      completed_at: 121300,
      duration_ms: 121300,
      output_tokens: 21411,
      reasoning_tokens: 21203,
      model_id: "deepseek-flash",
      finish_reason: "tool-calls",
    };
    const m = measureRequest(row);
    assert.equal(m.mode, "stream");
    assert.equal(m.pureTtftMs, 3800);
    // 21411 / 117.5s ≈ 182.2 tok/s
    assert.ok(m.tokPerSec > 180 && m.tokPerSec < 185);
  });

  it("prevents >2000 tok/s inflation when hidden thinking precedes a single-packet tool-call flush", () => {
    // Real observed anomaly: 91.86s opaque thinking + 175ms tool-call JSON flush
    const row = {
      started_at: 100000,
      first_token_at: 191861,
      completed_at: 192036,
      duration_ms: 92036,
      output_tokens: 492,
      reasoning_tokens: 359,
      model_id: "bzs/auto/gemini-4-argon",
      finish_reason: "tool-calls",
    };
    const m = measureRequest(row);
    assert.equal(m.mode, "e2e");
    assert.equal(m.pureTtftMs, null);
    assert.equal(m.firstVisibleMs, 91861);
    // 492 / 92.036s ≈ 5.35 tok/s, NEVER 2811 tok/s
    assert.ok(m.tokPerSec > 5 && m.tokPerSec < 6);
  });

  it("uses visible-stream rate when hidden thinking is followed by genuine streamed text", () => {
    const row = {
      started_at: 0,
      first_token_at: 57203,
      completed_at: 71482,
      duration_ms: 71482,
      output_tokens: 1268,
      reasoning_tokens: 734,
      model_id: "bzs/auto/gemini-4-argon",
      finish_reason: "tool-calls",
    };
    const m = measureRequest(row);
    assert.equal(m.mode, "vis-stream");
    assert.equal(m.pureTtftMs, null);
    // (1268 - 734 = 534) / 14.279s ≈ 37.4 tok/s
    assert.ok(Math.abs(m.tokPerSec - 534 / 14.279) < 0.1);
  });

  it("does not pollute pureTtftMs when >8s opaque thinking precedes a long visible stream", () => {
    const row = {
      started_at: 0,
      first_token_at: 24500,
      completed_at: 59500,
      duration_ms: 59500,
      output_tokens: 800,
      reasoning_tokens: 150,
      model_id: "bzs/auto/gemini-4-hydrogen",
      finish_reason: "stop",
    };
    const m = measureRequest(row);
    assert.equal(m.mode, "vis-stream");
    assert.equal(m.pureTtftMs, null);
    assert.equal(m.firstVisibleMs, 24500);
    assert.ok(Math.abs(m.tokPerSec - 650 / 35) < 0.1);
  });

  it("computes cacheHitRatio and chronological samples", () => {
    const now = 200_000;
    const rows = [
      {
        started_at: 190_000,
        first_token_at: 191_000,
        completed_at: 195_000,
        duration_ms: 5000,
        output_tokens: 200,
        reasoning_tokens: 0,
        input_tokens: 6000,
        cache_read_input_tokens: 4500,
        cache_creation_input_tokens: 0,
        model_id: "m1",
      },
      {
        started_at: 180_000,
        first_token_at: 181_000,
        completed_at: 183_000,
        duration_ms: 3000,
        output_tokens: 200,
        reasoning_tokens: 0,
        input_tokens: 4000,
        cache_read_input_tokens: 3500,
        cache_creation_input_tokens: 0,
        model_id: "m1",
      },
    ];
    const metrics = computeMetrics(rows, now);
    assert.equal(metrics.cacheHitRatio, 0.8); // 8000 / 10000
    assert.equal(metrics.speed.samples.length, 2);
    // Chronological order: older (100 tok/s) first, newer (50 tok/s) last
    assert.ok(Math.abs(metrics.speed.samples[0].tokPerSec - 100) < 0.01);
    assert.ok(Math.abs(metrics.speed.samples[1].tokPerSec - 50) < 0.01);
    // Weighted overall: 400 tok / 6s = 66.67 tok/s
    assert.ok(Math.abs(metrics.speed.overall - 400 / 6) < 0.1);
  });
});

describe("metrics: computeLiveActivity", () => {
  it("detects thinking right after user submits a message", () => {
    const live = computeLiveActivity(
      {
        message: {
          id: "m1",
          time_created: 10_000,
          time_updated: 10_000,
          data: JSON.stringify({ role: "user" }),
        },
        parts: [],
      },
      5000,
      14_200
    );
    assert.equal(live.active, true);
    assert.equal(live.phase, "thinking");
    assert.equal(live.elapsedMs, 4200);
  });

  it("detects live streaming rate from unfinished text part", () => {
    const text = "Hello world streaming tokens rapidly! ".repeat(20);
    const live = computeLiveActivity(
      {
        message: {
          id: "m2",
          time_created: 10_000,
          time_updated: 12_000,
          data: JSON.stringify({ role: "assistant" }),
        },
        parts: [
          {
            id: "p1",
            sequence: 1,
            time_created: 10_000,
            time_updated: 10_000,
            data: JSON.stringify({ type: "step-start" }),
          },
          {
            id: "p2",
            sequence: 2,
            time_created: 10_200,
            time_updated: 12_200,
            data: JSON.stringify({ type: "text", text }),
          },
        ],
      },
      5000,
      12_400
    );
    assert.equal(live.active, true);
    assert.equal(live.phase, "streaming");
    assert.ok(live.liveTokPerSec > 40);
  });

  it("detects running tool phase and returns idle when completed", () => {
    const toolLive = computeLiveActivity(
      {
        message: {
          id: "m3",
          time_created: 10_000,
          time_updated: 12_000,
          data: JSON.stringify({ role: "assistant" }),
        },
        parts: [
          {
            id: "p1",
            sequence: 1,
            time_created: 10_000,
            time_updated: 12_000,
            data: JSON.stringify({
              type: "tool",
              state: { status: "running" },
            }),
          },
        ],
      },
      11_500,
      13_000
    );
    assert.equal(toolLive.phase, "tool");

    const doneLive = computeLiveActivity(
      {
        message: {
          id: "m3",
          time_created: 10_000,
          time_updated: 15_000,
          data: JSON.stringify({ role: "assistant", time: { completed: 15_000 } }),
        },
        parts: [],
      },
      15_000,
      16_000
    );
    assert.equal(doneLive.active, false);
    assert.equal(doneLive.phase, "idle");
  });
});

describe("injection markers & meta cleanup", () => {
  it("strips both script blocks and duplicate meta tags cleanly", () => {
    const baseHtml = `<!doctype html><html><head>\n    <title>ZCode</title>\n  </head><body><div id="root"></div></body></html>`;
    const tag = computeChipVersionTag("console.log(1)");
    const injected = baseHtml
      .replace(
        /<head>/,
        `<head>\n    <meta name="bzs-token-speed-base" content="http://127.0.0.1:47816">\n    <meta name="bzs-token-speed-version" content="${tag}">`
      )
      .replace(/<\/body>/, `${injectSnippet("console.log(1)")}\n  </body>`);

    assert.equal(hasInjection(injected), true);
    assert.deepEqual(extractInjectedMeta(injected), {
      endpoint: "http://127.0.0.1:47816",
      versionTag: tag,
    });

    const { html: stripped, hadInjection } = stripInjection(injected);
    assert.equal(hadInjection, true);
    assert.equal(hasInjection(stripped), false);
    assert.ok(!stripped.includes("bzs-token-speed-base"));
    assert.ok(!stripped.includes("bzs-token-speed-version"));
  });
});

describe("SQLite integration, draft isolation & MCP tools", () => {
  let tmpDir = null;
  const prevEnv = process.env.ZCODE_SESSION_DB_PATH;

  afterEach(() => {
    dbModule.close();
    if (prevEnv === undefined) delete process.env.ZCODE_SESSION_DB_PATH;
    else process.env.ZCODE_SESSION_DB_PATH = prevEnv;
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it("queries session speed, isolates draft sessions, and serves MCP tools", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "bzs-tp-test-"));
    const dbFile = join(tmpDir, "db.sqlite");
    const setup = new DatabaseSync(dbFile);
    setup.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        title TEXT,
        directory TEXT,
        path TEXT,
        task_type TEXT,
        time_created INTEGER,
        time_updated INTEGER,
        time_deleted INTEGER
      );
      CREATE TABLE model_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        status TEXT,
        started_at INTEGER,
        first_token_at INTEGER,
        completed_at INTEGER,
        duration_ms INTEGER,
        time_to_first_token_ms INTEGER,
        output_tokens INTEGER,
        input_tokens INTEGER,
        cache_read_input_tokens INTEGER,
        cache_creation_input_tokens INTEGER,
        reasoning_tokens INTEGER,
        provider_id TEXT,
        model_id TEXT,
        query_source TEXT,
        finish_reason TEXT,
        tool_call_count INTEGER
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        sequence INTEGER,
        time_created INTEGER,
        time_updated INTEGER,
        data TEXT
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT,
        session_id TEXT,
        sequence INTEGER,
        time_created INTEGER,
        time_updated INTEGER,
        data TEXT
      );
    `);
    const now = Date.now();
    setup
      .prepare(
        `INSERT INTO session VALUES (?, ?, ?, ?, 'interactive', ?, ?, NULL)`
      )
      .run("sess_test_1", "Test Session", "D:\\Proj", "D:\\Proj", now - 5000, now - 1000);
    setup
      .prepare(
        `INSERT INTO model_usage (
          session_id, status, started_at, first_token_at, completed_at, duration_ms,
          time_to_first_token_ms, output_tokens, input_tokens, cache_read_input_tokens,
          cache_creation_input_tokens, reasoning_tokens, provider_id, model_id,
          query_source, finish_reason, tool_call_count
        ) VALUES (?, 'completed', ?, ?, ?, 4000, 1000, 300, 10000, 7500, 0, 50, 'p', 'GLM-5.3-Flash', 'main_turn', 'stop', 0)`
      )
      .run("sess_test_1", now - 5000, now - 4000, now - 1000);
    setup.close();

    process.env.ZCODE_SESSION_DB_PATH = dbFile;

    const draftSnap = sessionSpeedSnapshot({ sessionId: "draft" });
    assert.equal(draftSnap.session.resolvedBy, "draft");
    assert.equal(draftSnap.summary, null);

    const snap = currentSpeedSnapshot({ workingDir: "D:/Proj" });
    assert.equal(snap.session.id, "sess_test_1");
    assert.ok(Math.abs(snap.summary.latestTokPerSec - 100) < 0.1);
    assert.equal(snap.summary.cacheHitRatio, 0.75);

    const initReply = await handleMcp({ jsonrpc: "2.0", id: 1, method: "initialize" });
    assert.equal(initReply.result.serverInfo.version, "0.3.0");

    const callReply = await handleMcp({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "token_speed", arguments: { session_id: "sess_test_1" } },
    });
    assert.match(callReply.result.content[0].text, /100\.0 tok\/s/);
    assert.match(callReply.result.content[0].text, /75\.0%/);
  });
});
