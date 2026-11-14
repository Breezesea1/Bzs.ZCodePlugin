// TokenPulse composer chip: injected into ZCode's renderer (see scripts/install.mjs).
// Binds each composer toolbar to its exact pane `[data-session-id]`, participates in
// ZCode's `[data-composer-collapse-priority="extension"]` responsive collapse, renders
// a true per-request trajectory sparkline, and opens an interactive HUD popover on
// hover or click-to-pin.
(() => {
  "use strict";
  if (window.__bzsTokenPulseLoaded) return;
  window.__bzsTokenPulseLoaded = true;

  const ACTIVE_POLL_MS = 700;
  const IDLE_POLL_MS = 2400;
  const OFFLINE_POLL_MS = 5000;
  const SPARK_W = 46;
  const SPARK_H = 15;
  const MAX_BARS = 24;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const FALLBACK_BASES = ["http://127.0.0.1:47816"];

  const MODE_LABELS = {
    stream: "流式解码",
    "vis-stream": "思考后流式",
    e2e: "端到端吞吐",
  };

  const PHASE_LABELS = {
    idle: "空闲",
    thinking: "思考中",
    streaming: "流式输出",
    tool: "工具执行",
    draft: "新会话",
    offline: "未连接",
  };

  // ---- styles ---------------------------------------------------------------
  function injectStyles() {
    if (document.getElementById("bzs-token-pulse-style")) return;
    const style = document.createElement("style");
    style.id = "bzs-token-pulse-style";
    style.textContent = `
      .bzs-tp-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 28px;
        padding: 0 8px;
        border-radius: 8px;
        border: 1px solid transparent;
        background: transparent;
        color: var(--color-foreground-subtle, rgba(160, 165, 175, 0.9));
        font-family: var(--font-sans, ui-sans-serif, system-ui, sans-serif);
        font-size: 12px;
        line-height: 1;
        cursor: pointer;
        user-select: none;
        flex-shrink: 0;
        transition: background-color 0.14s ease, border-color 0.14s ease, color 0.14s ease;
      }
      .bzs-tp-chip:hover,
      .bzs-tp-chip[data-open="true"] {
        background: var(--color-hover, rgba(128, 128, 128, 0.1));
        border-color: var(--color-border, rgba(128, 128, 128, 0.18));
        color: var(--color-foreground, inherit);
      }
      .bzs-tp-chip[data-pinned="true"] {
        background: var(--color-selected, rgba(128, 128, 128, 0.14));
        border-color: var(--color-border-hover, rgba(128, 128, 128, 0.28));
      }
      .bzs-tp-dot-wrap {
        position: relative;
        display: inline-flex;
        width: 7px;
        height: 7px;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }
      .bzs-tp-dot {
        width: 6px;
        height: 6px;
        border-radius: 999px;
        background: var(--color-foreground-subtlest, rgba(140, 145, 155, 0.5));
        transition: background-color 0.2s ease, transform 0.2s ease;
      }
      .bzs-tp-ring {
        position: absolute;
        inset: -3px;
        border-radius: 999px;
        opacity: 0;
        pointer-events: none;
      }
      .bzs-tp-chip[data-has-data="true"][data-phase="idle"] .bzs-tp-dot {
        background: var(--color-success, #10b981);
        opacity: 0.78;
      }
      .bzs-tp-chip[data-phase="streaming"] .bzs-tp-dot {
        background: var(--color-success, #10b981);
      }
      .bzs-tp-chip[data-phase="streaming"] .bzs-tp-ring {
        border: 1.5px solid var(--color-success, #10b981);
        animation: bzs-tp-pulse 1.5s cubic-bezier(0.22, 1, 0.36, 1) infinite;
      }
      .bzs-tp-chip[data-phase="thinking"] .bzs-tp-dot {
        background: var(--color-icon-purple, #a855f7);
      }
      .bzs-tp-chip[data-phase="thinking"] .bzs-tp-ring {
        border: 1.5px solid var(--color-icon-purple, #a855f7);
        animation: bzs-tp-pulse 1.6s cubic-bezier(0.22, 1, 0.36, 1) infinite;
      }
      .bzs-tp-chip[data-phase="tool"] .bzs-tp-dot {
        background: var(--color-warning, #f59e0b);
      }
      .bzs-tp-chip[data-phase="tool"] .bzs-tp-ring {
        border: 1.5px solid var(--color-warning, #f59e0b);
        animation: bzs-tp-pulse 1.9s cubic-bezier(0.22, 1, 0.36, 1) infinite;
      }
      @keyframes bzs-tp-pulse {
        0% { transform: scale(0.65); opacity: 0.75; }
        80%, 100% { transform: scale(1.55); opacity: 0; }
      }
      .bzs-tp-spark {
        display: block;
        overflow: visible;
        flex-shrink: 0;
        color: var(--color-success, #10b981);
        opacity: 0.88;
      }
      .bzs-tp-chip[data-phase="thinking"] .bzs-tp-spark {
        color: var(--color-icon-purple, #a855f7);
      }
      .bzs-tp-spark[data-empty="true"] {
        display: none;
      }
      .bzs-tp-readout {
        display: inline-flex;
        align-items: baseline;
        gap: 2.5px;
        font-family: var(--font-mono, ui-monospace, SFMono-Regular, Consolas, monospace);
        font-variant-numeric: tabular-nums;
      }
      .bzs-tp-val {
        font-size: 12px;
        font-weight: 500;
        color: var(--color-foreground, inherit);
        letter-spacing: -0.01em;
      }
      .bzs-tp-chip[data-has-data="false"]:not([data-phase="thinking"]):not([data-phase="streaming"]) .bzs-tp-val {
        color: var(--color-foreground-subtle, inherit);
      }
      .bzs-tp-unit {
        font-size: 10.5px;
        color: var(--color-foreground-subtle, rgba(150, 155, 165, 0.8));
        opacity: 0.78;
      }
      .bzs-tp-chip[data-composer-compact="true"] {
        padding: 0 6px;
        gap: 4.5px;
      }
      .bzs-tp-chip[data-composer-compact="true"] .bzs-tp-spark,
      .bzs-tp-chip[data-composer-compact="true"] .bzs-tp-unit {
        display: none;
      }

      /* Floating HUD Popover */
      .bzs-tp-popover {
        position: fixed;
        z-index: 2147483600;
        width: 304px;
        padding: 12px;
        border-radius: 12px;
        background: var(--color-popover, rgba(24, 25, 28, 0.96));
        color: var(--color-popover-foreground, var(--color-foreground, #f3f4f6));
        border: 1px solid var(--color-popover-border, var(--color-border, rgba(128, 128, 128, 0.22)));
        box-shadow:
          0 16px 36px -8px rgba(0, 0, 0, 0.34),
          0 4px 12px -2px rgba(0, 0, 0, 0.18);
        backdrop-filter: blur(16px);
        font-family: var(--font-sans, ui-sans-serif, system-ui, sans-serif);
        font-size: 12px;
        line-height: 1.4;
        user-select: none;
        opacity: 0;
        transform: translateY(4px) scale(0.985);
        pointer-events: none;
        transition: opacity 0.14s ease, transform 0.14s cubic-bezier(0.22, 1, 0.36, 1);
      }
      .bzs-tp-popover[data-visible="true"] {
        opacity: 1;
        transform: translateY(0) scale(1);
        pointer-events: auto;
      }
      .bzs-tp-hd {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 10px;
      }
      .bzs-tp-brand {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-weight: 600;
        font-size: 12.5px;
        letter-spacing: -0.01em;
      }
      .bzs-tp-badge {
        display: inline-flex;
        align-items: center;
        padding: 1.5px 6px;
        border-radius: 999px;
        font-size: 10.5px;
        font-weight: 500;
        background: var(--color-surface, rgba(128, 128, 128, 0.14));
        color: var(--color-foreground-subtle, rgba(160, 165, 175, 0.95));
      }
      .bzs-tp-badge[data-phase="streaming"] {
        background: color-mix(in oklab, var(--color-success, #10b981) 16%, transparent);
        color: var(--color-success, #10b981);
      }
      .bzs-tp-badge[data-phase="thinking"] {
        background: color-mix(in oklab, var(--color-icon-purple, #a855f7) 16%, transparent);
        color: var(--color-icon-purple, #a855f7);
      }
      .bzs-tp-badge[data-phase="tool"] {
        background: color-mix(in oklab, var(--color-warning, #f59e0b) 16%, transparent);
        color: var(--color-warning, #f59e0b);
      }
      .bzs-tp-model {
        max-width: 126px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-family: var(--font-mono, monospace);
        font-size: 11px;
        color: var(--color-foreground-subtle, rgba(160, 165, 175, 0.9));
      }
      .bzs-tp-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
        margin-bottom: 10px;
      }
      .bzs-tp-card {
        padding: 7px 9px;
        border-radius: 8px;
        background: var(--color-surface, rgba(128, 128, 128, 0.08));
        border: 1px solid color-mix(in oklab, var(--color-border, rgba(128, 128, 128, 0.2)) 55%, transparent);
      }
      .bzs-tp-card-lbl {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 10.5px;
        color: var(--color-foreground-subtle, rgba(160, 165, 175, 0.88));
        margin-bottom: 2px;
      }
      .bzs-tp-card-val {
        font-family: var(--font-mono, monospace);
        font-variant-numeric: tabular-nums;
        font-size: 15px;
        font-weight: 600;
        letter-spacing: -0.02em;
        color: var(--color-foreground, inherit);
      }
      .bzs-tp-card-val small {
        font-size: 10.5px;
        font-weight: 400;
        margin-left: 2px;
        color: var(--color-foreground-subtle, rgba(160, 165, 175, 0.85));
      }
      .bzs-tp-card-sub {
        font-size: 10px;
        color: var(--color-foreground-subtlest, rgba(145, 150, 160, 0.78));
        margin-top: 1px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .bzs-tp-chart-box {
        padding: 8px 9px 7px;
        border-radius: 8px;
        background: var(--color-surface, rgba(128, 128, 128, 0.08));
        border: 1px solid color-mix(in oklab, var(--color-border, rgba(128, 128, 128, 0.2)) 55%, transparent);
        margin-bottom: 9px;
      }
      .bzs-tp-bars {
        display: flex;
        align-items: flex-end;
        gap: 2.5px;
        height: 34px;
        margin-bottom: 5px;
      }
      .bzs-tp-bar {
        flex: 1 1 0%;
        min-width: 4px;
        max-width: 12px;
        border-radius: 2px 2px 1px 1px;
        background: color-mix(in oklab, var(--color-success, #10b981) 52%, transparent);
        transition: height 0.18s ease, background-color 0.12s ease, opacity 0.12s ease;
        cursor: crosshair;
      }
      .bzs-tp-bar[data-mode="vis-stream"] {
        background: color-mix(in oklab, var(--color-icon-blue, #3b82f6) 58%, transparent);
      }
      .bzs-tp-bar[data-mode="e2e"] {
        background: color-mix(in oklab, var(--color-icon-purple, #a855f7) 52%, transparent);
      }
      .bzs-tp-bar[data-latest="true"],
      .bzs-tp-bar:hover {
        background: var(--color-success, #10b981);
      }
      .bzs-tp-bar[data-mode="vis-stream"][data-latest="true"],
      .bzs-tp-bar[data-mode="vis-stream"]:hover {
        background: var(--color-icon-blue, #3b82f6);
      }
      .bzs-tp-bar[data-mode="e2e"][data-latest="true"],
      .bzs-tp-bar[data-mode="e2e"]:hover {
        background: var(--color-icon-purple, #a855f7);
      }
      .bzs-tp-bar-caption {
        font-family: var(--font-mono, monospace);
        font-variant-numeric: tabular-nums;
        font-size: 10.5px;
        color: var(--color-foreground-subtle, rgba(160, 165, 175, 0.9));
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .bzs-tp-foot {
        display: flex;
        flex-direction: column;
        gap: 5px;
      }
      .bzs-tp-cache-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        font-size: 11px;
        color: var(--color-foreground-subtle, rgba(160, 165, 175, 0.9));
      }
      .bzs-tp-cache-track {
        flex: 1;
        height: 4px;
        border-radius: 999px;
        background: color-mix(in oklab, var(--color-border, rgba(128, 128, 128, 0.3)) 70%, transparent);
        overflow: hidden;
      }
      .bzs-tp-cache-fill {
        height: 100%;
        border-radius: inherit;
        background: var(--color-success, #10b981);
        transition: width 0.24s ease;
      }
      .bzs-tp-totals {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-family: var(--font-mono, monospace);
        font-variant-numeric: tabular-nums;
        font-size: 10.5px;
        color: var(--color-foreground-subtlest, rgba(145, 150, 160, 0.85));
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // ---- formatting helpers ---------------------------------------------------
  function setAttrIfChanged(el, name, val) {
    if (val == null) {
      if (el.hasAttribute(name)) el.removeAttribute(name);
      return;
    }
    const str = String(val);
    if (el.getAttribute(name) !== str) el.setAttribute(name, str);
  }

  function setTextIfChanged(el, val) {
    const str = val == null ? "" : String(val);
    if (el.textContent !== str) el.textContent = str;
  }

  function fmtRate(v) {
    if (v == null || !Number.isFinite(v)) return "—";
    return v >= 100 ? v.toFixed(0) : v.toFixed(1);
  }

  function fmtRateDetailed(v) {
    if (v == null || !Number.isFinite(v)) return "—";
    return v.toFixed(1);
  }

  function fmtTokens(v) {
    if (v == null || !Number.isFinite(v)) return "0";
    if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
    return String(Math.round(v));
  }

  function fmtDurationMs(ms) {
    if (ms == null || !Number.isFinite(ms)) return "—";
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  }

  function shortModelName(model) {
    if (!model) return "—";
    const parts = String(model).split("/");
    return parts[parts.length - 1] || model;
  }

  // ---- endpoint discovery ---------------------------------------------------
  function metaEndpoint() {
    return (
      document.documentElement.getAttribute("data-bzs-token-speed-base") ??
      document.querySelector('meta[name="bzs-token-speed-base"]')?.content ??
      null
    );
  }

  let activeBase = null;

  async function fetchSnapshot(sessionId) {
    const query = sessionId
      ? `/api/snapshot?session=${encodeURIComponent(sessionId)}`
      : "/api/snapshot";
    const primary = activeBase ?? metaEndpoint();
    const candidates = [
      ...(primary ? [primary] : []),
      ...FALLBACK_BASES.filter((b) => b !== primary),
    ];

    for (const base of candidates) {
      try {
        const res = await fetch(`${base}${query}`, {
          cache: "no-store",
          signal: AbortSignal.timeout(1800),
        });
        if (!res.ok) continue;
        const json = await res.json();
        activeBase = base;
        return { ok: true, data: json };
      } catch {
        if (activeBase === base) activeBase = null;
      }
    }
    return { ok: false, data: null };
  }

  // ---- sparkline geometry ---------------------------------------------------
  function computeSparkGeometry(samples, liveRate) {
    const pts = [];
    if (Array.isArray(samples)) {
      for (const s of samples.slice(-20)) {
        if (s && Number.isFinite(s.tokPerSec) && s.tokPerSec > 0) {
          pts.push(s.tokPerSec);
        }
      }
    }
    if (Number.isFinite(liveRate) && liveRate > 0) {
      pts.push(liveRate);
    }
    if (pts.length < 2) return null;

    const peak = Math.max(...pts, 35);
    const scaleMax = peak * 1.12;
    const padX = 1.5;
    const padTop = 2;
    const padBot = 2;
    const innerW = SPARK_W - padX * 2;
    const innerH = SPARK_H - padTop - padBot;

    const coords = pts.map((v, idx) => {
      const x = padX + (idx / (pts.length - 1)) * innerW;
      const ratio = Math.min(1, Math.max(0.05, v / scaleMax));
      const y = padTop + (1 - ratio) * innerH;
      return [x, y];
    });

    const linePoints = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    const firstX = coords[0][0].toFixed(1);
    const last = coords[coords.length - 1];
    const bottomY = (SPARK_H - 1).toFixed(1);
    const areaPoints = `${firstX},${bottomY} ${linePoints} ${last[0].toFixed(1)},${bottomY}`;

    return {
      linePoints,
      areaPoints,
      endX: last[0].toFixed(1),
      endY: last[1].toFixed(1),
    };
  }

  // ---- shared floating HUD popover ------------------------------------------
  const popover = (() => {
    let root = null;
    let els = null;
    let owner = null;
    let pinned = false;
    let openTimer = 0;
    let closeTimer = 0;
    let hoveredSampleIdx = -1;

    function ensureDom() {
      if (root && root.isConnected) return;
      root = document.createElement("div");
      root.className = "bzs-tp-popover";
      root.setAttribute("role", "dialog");
      root.setAttribute("aria-label", "TokenPulse 会话速率详情");

      const hd = document.createElement("div");
      hd.className = "bzs-tp-hd";
      const brandWrap = document.createElement("div");
      brandWrap.className = "bzs-tp-brand";
      const brandTitle = document.createElement("span");
      brandTitle.textContent = "TokenPulse";
      const badge = document.createElement("span");
      badge.className = "bzs-tp-badge";
      brandWrap.append(brandTitle, badge);
      const modelEl = document.createElement("span");
      modelEl.className = "bzs-tp-model";
      hd.append(brandWrap, modelEl);

      const grid = document.createElement("div");
      grid.className = "bzs-tp-grid";
      const makeCard = (label) => {
        const card = document.createElement("div");
        card.className = "bzs-tp-card";
        const lbl = document.createElement("div");
        lbl.className = "bzs-tp-card-lbl";
        lbl.textContent = label;
        const val = document.createElement("div");
        val.className = "bzs-tp-card-val";
        const num = document.createElement("span");
        const unit = document.createElement("small");
        val.append(num, unit);
        const sub = document.createElement("div");
        sub.className = "bzs-tp-card-sub";
        card.append(lbl, val, sub);
        grid.appendChild(card);
        return { lbl, num, unit, sub };
      };

      const cLatest = makeCard("最新速率");
      const cRecent = makeCard("10 分钟加权");
      const cPeak = makeCard("峰值 / 全程");
      const cTtft = makeCard("首字延迟 TTFT");

      const chartBox = document.createElement("div");
      chartBox.className = "bzs-tp-chart-box";
      const barsWrap = document.createElement("div");
      barsWrap.className = "bzs-tp-bars";
      const barCaption = document.createElement("div");
      barCaption.className = "bzs-tp-bar-caption";
      chartBox.append(barsWrap, barCaption);

      const foot = document.createElement("div");
      foot.className = "bzs-tp-foot";
      const cacheRow = document.createElement("div");
      cacheRow.className = "bzs-tp-cache-row";
      const cacheLabel = document.createElement("span");
      const cacheTrack = document.createElement("div");
      cacheTrack.className = "bzs-tp-cache-track";
      const cacheFill = document.createElement("div");
      cacheFill.className = "bzs-tp-cache-fill";
      cacheTrack.appendChild(cacheFill);
      const cachePct = document.createElement("span");
      cachePct.style.fontFamily = "var(--font-mono, monospace)";
      cacheRow.append(cacheLabel, cacheTrack, cachePct);

      const totals = document.createElement("div");
      totals.className = "bzs-tp-totals";
      const totalsLeft = document.createElement("span");
      const totalsRight = document.createElement("span");
      totals.append(totalsLeft, totalsRight);
      foot.append(cacheRow, totals);

      root.append(hd, grid, chartBox, foot);

      root.addEventListener("mouseenter", () => {
        window.clearTimeout(closeTimer);
      });
      root.addEventListener("mouseleave", () => {
        if (!pinned) scheduleClose();
      });

      document.body.appendChild(root);
      els = {
        badge,
        modelEl,
        cLatest,
        cRecent,
        cPeak,
        cTtft,
        chartBox,
        barsWrap,
        barCaption,
        cacheLabel,
        cacheFill,
        cachePct,
        totalsLeft,
        totalsRight,
      };
    }

    function positionNear(anchorEl) {
      if (!root || !anchorEl || !anchorEl.isConnected) return;
      const rect = anchorEl.getBoundingClientRect();
      const popW = root.offsetWidth || 304;
      const popH = root.offsetHeight || 236;
      const pad = 10;

      let left = rect.left;
      if (left + popW > window.innerWidth - pad) {
        left = Math.max(pad, window.innerWidth - popW - pad);
      }
      left = Math.max(pad, left);

      let top = rect.top - popH - 8;
      if (top < pad) {
        top = Math.min(window.innerHeight - popH - pad, rect.bottom + 8);
      }
      root.style.left = `${Math.round(left)}px`;
      root.style.top = `${Math.round(top)}px`;
    }

    function formatSampleCaption(sample, idx, total) {
      if (!sample) return "暂无已完成请求样本";
      const modeText = MODE_LABELS[sample.mode] ?? sample.mode ?? "";
      const rsnPart =
        sample.reasoningTokens > 0 ? ` (含思考 ${fmtTokens(sample.reasoningTokens)})` : "";
      return `#${idx + 1}/${total} · ${fmtRateDetailed(sample.tokPerSec)} tok/s · ${fmtTokens(sample.outputTokens)} tok${rsnPart} · ${fmtDurationMs(sample.genMs)} · ${modeText}`;
    }

    function updateContent(inst) {
      if (!root || !els || !inst) return;
      const s = inst.summary;
      const phase = inst.effectivePhase();
      setAttrIfChanged(els.badge, "data-phase", phase);
      const subN = inst.runningSubagents();
      const subSuffix = subN > 0 ? ` · ${subN} 子代理` : "";
      setTextIfChanged(
        els.badge,
        `${PHASE_LABELS[phase] ?? phase}${pinned ? " · 已固定" : ""}${subSuffix}`
      );
      setTextIfChanged(els.modelEl, shortModelName(s?.latestModel));
      els.modelEl.title = s?.latestModel ?? "";

      if (!inst.ok) {
        setTextIfChanged(els.cLatest.num, "—");
        setTextIfChanged(els.cLatest.unit, "");
        setTextIfChanged(els.cLatest.sub, "等待 MCP 服务连接…");
        setTextIfChanged(els.cRecent.num, "—");
        setTextIfChanged(els.cRecent.unit, "");
        setTextIfChanged(els.cRecent.sub, "端口 47816 未就绪");
        setTextIfChanged(els.cPeak.num, "—");
        setTextIfChanged(els.cPeak.unit, "");
        setTextIfChanged(els.cPeak.sub, "—");
        setTextIfChanged(els.cTtft.num, "—");
        setTextIfChanged(els.cTtft.unit, "");
        setTextIfChanged(els.cTtft.sub, "—");
        els.chartBox.style.display = "none";
        setTextIfChanged(els.cacheLabel, "缓存命中");
        els.cacheFill.style.width = "0%";
        setTextIfChanged(els.cachePct, "—");
        setTextIfChanged(els.totalsLeft, "发起任意对话后自动唤醒");
        setTextIfChanged(els.totalsRight, "");
        positionNear(inst.el);
        return;
      }

      const liveRate = s?.liveTokPerSec;
      const showLive =
        (phase === "streaming" || phase === "thinking") &&
        liveRate != null &&
        Number.isFinite(liveRate);

      setTextIfChanged(
        els.cLatest.lbl,
        showLive ? "实时流式速率" : "最新速率"
      );
      setTextIfChanged(
        els.cLatest.num,
        showLive ? `~${fmtRateDetailed(liveRate)}` : fmtRateDetailed(s?.latestTokPerSec)
      );
      setTextIfChanged(
        els.cLatest.unit,
        showLive || s?.latestTokPerSec != null ? "tok/s" : ""
      );
      setTextIfChanged(
        els.cLatest.sub,
        showLive
          ? `当前步骤约 ${fmtTokens(s?.liveTokens ?? 0)} tok`
          : s?.latestMode
            ? `${MODE_LABELS[s.latestMode] ?? s.latestMode} · ${fmtTokens(s.latestTokens)} tok`
            : phase === "thinking"
              ? `思考耗时 ${fmtDurationMs(inst.currentThinkingMs())}`
              : "等待首个请求完成"
      );

      setTextIfChanged(els.cRecent.num, fmtRateDetailed(s?.recent10m));
      setTextIfChanged(els.cRecent.unit, s?.recent10m != null ? "tok/s" : "");
      setTextIfChanged(
        els.cRecent.sub,
        s?.recentCount ? `近 10 分钟 ${s.recentCount} 次请求` : "近 10 分钟无请求"
      );

      setTextIfChanged(els.cPeak.num, fmtRateDetailed(s?.peak));
      setTextIfChanged(els.cPeak.unit, s?.peak != null ? "tok/s" : "");
      setTextIfChanged(
        els.cPeak.sub,
        s?.overall != null ? `全程加权 ${fmtRateDetailed(s.overall)} tok/s` : "全程加权 —"
      );

      const pureTtft = s?.pureTtftMs;
      const firstVis = s?.avgFirstVisibleMs;
      const ttftVal = pureTtft ?? firstVis ?? null;
      setTextIfChanged(
        els.cTtft.num,
        ttftVal != null ? fmtDurationMs(ttftVal) : "—"
      );
      setTextIfChanged(els.cTtft.unit, "");
      setTextIfChanged(
        els.cTtft.sub,
        pureTtft != null
          ? "首 token 网络与预填充"
          : firstVis != null
            ? "含服务端前置思考阶段"
            : "暂无可观测样本"
      );

      const samples = Array.isArray(s?.samples) ? s.samples.slice(-MAX_BARS) : [];
      if (samples.length > 0) {
        els.chartBox.style.display = "block";
        const maxRate = Math.max(...samples.map((x) => x.tokPerSec || 0), 30);
        while (els.barsWrap.children.length > samples.length) {
          els.barsWrap.lastElementChild.remove();
        }
        while (els.barsWrap.children.length < samples.length) {
          const b = document.createElement("div");
          b.className = "bzs-tp-bar";
          b.addEventListener("mouseenter", () => {
            const i = Number(b.dataset.idx);
            hoveredSampleIdx = Number.isInteger(i) ? i : -1;
            if (owner) updateContent(owner);
          });
          b.addEventListener("mouseleave", () => {
            hoveredSampleIdx = -1;
            if (owner) updateContent(owner);
          });
          els.barsWrap.appendChild(b);
        }
        samples.forEach((smp, i) => {
          const bar = els.barsWrap.children[i];
          const pct = Math.max(12, Math.min(100, ((smp.tokPerSec || 0) / maxRate) * 100));
          bar.style.height = `${pct.toFixed(1)}%`;
          setAttrIfChanged(bar, "data-idx", i);
          setAttrIfChanged(bar, "data-mode", smp.mode || "stream");
          setAttrIfChanged(
            bar,
            "data-latest",
            i === samples.length - 1 ? "true" : null
          );
        });
        const activeIdx =
          hoveredSampleIdx >= 0 && hoveredSampleIdx < samples.length
            ? hoveredSampleIdx
            : samples.length - 1;
        setTextIfChanged(
          els.barCaption,
          formatSampleCaption(samples[activeIdx], activeIdx, samples.length)
        );
      } else {
        els.chartBox.style.display = "none";
      }

      const hit = s?.cacheHitRatio;
      setTextIfChanged(els.cacheLabel, "缓存命中");
      els.cacheFill.style.width = hit != null ? `${(hit * 100).toFixed(1)}%` : "0%";
      setTextIfChanged(
        els.cachePct,
        hit != null ? `${(hit * 100).toFixed(0)}%` : "—"
      );

      setTextIfChanged(
        els.totalsLeft,
        `输出 ${fmtTokens(s?.outputTokens ?? 0)} · 思考 ${fmtTokens(s?.reasoningTokens ?? 0)} · 输入 ${fmtTokens(s?.inputTokens ?? 0)}`
      );
      setTextIfChanged(els.totalsRight, `${s?.requestCount ?? 0} 次请求`);
      positionNear(inst.el);
    }

    function open(inst, pin = false) {
      window.clearTimeout(closeTimer);
      window.clearTimeout(openTimer);
      ensureDom();
      if (owner && owner !== inst) {
        setAttrIfChanged(owner.el, "data-open", null);
        setAttrIfChanged(owner.el, "data-pinned", null);
      }
      owner = inst;
      if (pin) pinned = true;
      hoveredSampleIdx = -1;
      setAttrIfChanged(inst.el, "data-open", "true");
      setAttrIfChanged(inst.el, "data-pinned", pinned ? "true" : null);
      updateContent(inst);
      setAttrIfChanged(root, "data-visible", "true");
    }

    function scheduleOpen(inst) {
      window.clearTimeout(closeTimer);
      if (pinned && owner && owner !== inst) return;
      if (owner === inst && root?.getAttribute("data-visible") === "true") return;
      window.clearTimeout(openTimer);
      openTimer = window.setTimeout(() => open(inst, false), 140);
    }

    function closeNow() {
      window.clearTimeout(openTimer);
      window.clearTimeout(closeTimer);
      pinned = false;
      hoveredSampleIdx = -1;
      if (owner) {
        setAttrIfChanged(owner.el, "data-open", null);
        setAttrIfChanged(owner.el, "data-pinned", null);
        owner = null;
      }
      if (root) setAttrIfChanged(root, "data-visible", null);
    }

    function scheduleClose() {
      if (pinned) return;
      window.clearTimeout(openTimer);
      window.clearTimeout(closeTimer);
      closeTimer = window.setTimeout(closeNow, 180);
    }

    function togglePin(inst) {
      if (owner === inst && pinned) {
        closeNow();
      } else {
        pinned = true;
        open(inst, true);
      }
    }

    document.addEventListener(
      "pointerdown",
      (ev) => {
        if (!owner) return;
        const target = ev.target;
        if (
          target instanceof Node &&
          (root?.contains(target) || owner.el.contains(target))
        ) {
          return;
        }
        closeNow();
      },
      true
    );

    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && owner) closeNow();
    });

    window.addEventListener(
      "resize",
      () => {
        if (owner) positionNear(owner.el);
      },
      { passive: true }
    );

    return {
      scheduleOpen,
      scheduleClose,
      togglePin,
      closeIfOwner(inst) {
        if (owner === inst) closeNow();
      },
      refreshIfOwner(inst) {
        if (owner === inst && root?.getAttribute("data-visible") === "true") {
          updateContent(inst);
        }
      },
    };
  })();

  // ---- per-composer chip controller -----------------------------------------
  let nextGradSeq = 1;
  const controllers = new Map(); // anchor element -> ChipController

  class ChipController {
    constructor(anchor) {
      this.anchor = anchor;
      this.gradId = `bzs-tp-grad-${nextGradSeq++}`;
      this.ok = false;
      this.sessionId = null;
      this.summary = null;
      this.lastPollAt = 0;
      this.inFlight = false;
      this.lastProjSeq = "";
      this.lastProjMoveAt = 0;
      this.thinkingBaseMs = 0;
      this.thinkingBaseAt = 0;

      this.el = this.buildDom();
      anchor.appendChild(this.el);
    }

    buildDom() {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "bzs-tp-chip";
      btn.setAttribute("data-bzs-token-speed", "chip");
      btn.setAttribute("data-composer-collapse-priority", "extension");
      btn.setAttribute("data-phase", "idle");
      btn.setAttribute("data-has-data", "false");
      btn.setAttribute("aria-label", "TokenPulse 速率指示器");

      const dotWrap = document.createElement("span");
      dotWrap.className = "bzs-tp-dot-wrap";
      const ring = document.createElement("span");
      ring.className = "bzs-tp-ring";
      const dot = document.createElement("span");
      dot.className = "bzs-tp-dot";
      dotWrap.append(ring, dot);

      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("class", "bzs-tp-spark");
      svg.setAttribute("width", String(SPARK_W));
      svg.setAttribute("height", String(SPARK_H));
      svg.setAttribute("viewBox", `0 0 ${SPARK_W} ${SPARK_H}`);
      svg.setAttribute("aria-hidden", "true");
      svg.setAttribute("data-empty", "true");

      const defs = document.createElementNS(SVG_NS, "defs");
      const grad = document.createElementNS(SVG_NS, "linearGradient");
      grad.setAttribute("id", this.gradId);
      grad.setAttribute("x1", "0");
      grad.setAttribute("y1", "0");
      grad.setAttribute("x2", "0");
      grad.setAttribute("y2", "1");
      const stop1 = document.createElementNS(SVG_NS, "stop");
      stop1.setAttribute("offset", "0%");
      stop1.setAttribute("stop-color", "currentColor");
      stop1.setAttribute("stop-opacity", "0.28");
      const stop2 = document.createElementNS(SVG_NS, "stop");
      stop2.setAttribute("offset", "100%");
      stop2.setAttribute("stop-color", "currentColor");
      stop2.setAttribute("stop-opacity", "0.0");
      grad.append(stop1, stop2);
      defs.appendChild(grad);

      this.areaEl = document.createElementNS(SVG_NS, "polygon");
      this.areaEl.setAttribute("fill", `url(#${this.gradId})`);

      this.lineEl = document.createElementNS(SVG_NS, "polyline");
      this.lineEl.setAttribute("fill", "none");
      this.lineEl.setAttribute("stroke", "currentColor");
      this.lineEl.setAttribute("stroke-width", "1.45");
      this.lineEl.setAttribute("stroke-linejoin", "round");
      this.lineEl.setAttribute("stroke-linecap", "round");

      this.endDotEl = document.createElementNS(SVG_NS, "circle");
      this.endDotEl.setAttribute("r", "1.75");
      this.endDotEl.setAttribute("fill", "currentColor");

      svg.append(defs, this.areaEl, this.lineEl, this.endDotEl);
      this.svgEl = svg;

      const readout = document.createElement("span");
      readout.className = "bzs-tp-readout";
      this.valEl = document.createElement("span");
      this.valEl.className = "bzs-tp-val";
      this.valEl.textContent = "—";
      this.unitEl = document.createElement("span");
      this.unitEl.className = "bzs-tp-unit";
      this.unitEl.textContent = "";
      readout.append(this.valEl, this.unitEl);

      btn.append(dotWrap, svg, readout);

      btn.addEventListener("mouseenter", () => popover.scheduleOpen(this));
      btn.addEventListener("mouseleave", () => popover.scheduleClose());
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        popover.togglePin(this);
      });

      return btn;
    }

    paneRoot() {
      return this.anchor.closest("[data-session-id]");
    }

    resolveDomSessionId() {
      const pane = this.paneRoot();
      if (!pane) return null;
      const seq = pane.getAttribute("data-projection-seq") ?? "";
      if (seq && seq !== this.lastProjSeq) {
        if (this.lastProjSeq !== "") this.lastProjMoveAt = Date.now();
        this.lastProjSeq = seq;
      }
      return pane.getAttribute("data-session-id") || null;
    }

    runningSubagents() {
      const pane = this.paneRoot();
      if (!pane) return 0;
      const raw = pane.getAttribute("data-running-subagent-ids") ?? "";
      if (!raw) return 0;
      return raw.split(",").filter(Boolean).length;
    }

    effectivePhase() {
      const sid = this.resolveDomSessionId();
      if (sid === "draft") return "draft";
      if (!this.ok) return "offline";
      const backendPhase = this.summary?.phase ?? "idle";
      if (backendPhase !== "idle") return backendPhase;
      if (Date.now() - this.lastProjMoveAt < 1400) return "streaming";
      return "idle";
    }

    currentThinkingMs() {
      if (this.thinkingBaseAt <= 0) return this.summary?.liveElapsedMs ?? 0;
      return this.thinkingBaseMs + Math.max(0, Date.now() - this.thinkingBaseAt);
    }

    pollIntervalMs() {
      if (!this.ok) return OFFLINE_POLL_MS;
      const phase = this.effectivePhase();
      if (phase === "thinking" || phase === "streaming" || phase === "tool") {
        return ACTIVE_POLL_MS;
      }
      return IDLE_POLL_MS;
    }

    async tick(now) {
      const domSession = this.resolveDomSessionId();
      const sessionChanged = domSession !== this.sessionId;
      if (sessionChanged) {
        this.sessionId = domSession;
        this.lastProjMoveAt = 0;
        if (domSession === "draft") {
          this.ok = true;
          this.summary = null;
          this.render();
          return;
        }
      }

      if (domSession === "draft") {
        this.ok = true;
        this.summary = null;
        this.render();
        return;
      }

      const due =
        sessionChanged ||
        this.lastPollAt === 0 ||
        now - this.lastPollAt >= this.pollIntervalMs();

      if (due && !this.inFlight) {
        this.inFlight = true;
        this.lastPollAt = now;
        try {
          const res = await fetchSnapshot(domSession);
          this.ok = res.ok;
          if (res.ok) {
            this.summary = res.data?.summary ?? null;
            if (this.summary?.liveElapsedMs != null) {
              this.thinkingBaseMs = this.summary.liveElapsedMs;
              this.thinkingBaseAt = Date.now();
            } else {
              this.thinkingBaseMs = 0;
              this.thinkingBaseAt = 0;
            }
          }
        } finally {
          this.inFlight = false;
        }
      }

      this.render();
    }

    render() {
      const s = this.summary;
      const phase = this.effectivePhase();
      const hasSpeed = s?.latestTokPerSec != null && Number.isFinite(s.latestTokPerSec);
      const liveRate =
        (phase === "streaming" || phase === "thinking") &&
        s?.liveTokPerSec != null &&
        Number.isFinite(s.liveTokPerSec)
          ? s.liveTokPerSec
          : null;

      setAttrIfChanged(this.el, "data-phase", phase);
      setAttrIfChanged(this.el, "data-has-data", hasSpeed || liveRate != null ? "true" : "false");

      if (liveRate != null) {
        setTextIfChanged(this.valEl, fmtRate(liveRate));
        setTextIfChanged(this.unitEl, "t/s");
      } else if (phase === "thinking") {
        const sec = Math.floor(this.currentThinkingMs() / 1000);
        setTextIfChanged(this.valEl, sec >= 2 ? `思考 ${sec}s` : "思考…");
        setTextIfChanged(this.unitEl, "");
      } else if (hasSpeed) {
        setTextIfChanged(this.valEl, fmtRate(s.latestTokPerSec));
        setTextIfChanged(this.unitEl, "t/s");
      } else {
        setTextIfChanged(this.valEl, "—");
        setTextIfChanged(this.unitEl, "");
      }

      const geo = computeSparkGeometry(s?.samples, liveRate);
      if (geo) {
        setAttrIfChanged(this.svgEl, "data-empty", "false");
        setAttrIfChanged(this.areaEl, "points", geo.areaPoints);
        setAttrIfChanged(this.lineEl, "points", geo.linePoints);
        setAttrIfChanged(this.endDotEl, "cx", geo.endX);
        setAttrIfChanged(this.endDotEl, "cy", geo.endY);
      } else {
        setAttrIfChanged(this.svgEl, "data-empty", "true");
      }

      popover.refreshIfOwner(this);
    }

    destroy() {
      popover.closeIfOwner(this);
      if (this.el.isConnected) this.el.remove();
    }
  }

  // ---- mount & lifecycle loop -----------------------------------------------
  function syncControllers() {
    injectStyles();
    const anchors = document.querySelectorAll("[data-composer-leading-content]");
    const liveSet = new Set(anchors);

    for (const [anchor, ctrl] of controllers.entries()) {
      if (!liveSet.has(anchor) || !anchor.isConnected) {
        ctrl.destroy();
        controllers.delete(anchor);
      }
    }

    for (const anchor of liveSet) {
      // Skip ephemeral off-DOM measurement clones created by ZCode's responsive layout.
      if (!anchor.isConnected) continue;
      let ctrl = controllers.get(anchor);
      if (!ctrl) {
        // Remove any leftover static clone child if present before mounting fresh controller.
        for (const stale of anchor.querySelectorAll('[data-bzs-token-speed="chip"]')) {
          stale.remove();
        }
        ctrl = new ChipController(anchor);
        controllers.set(anchor, ctrl);
      } else if (!ctrl.el.isConnected) {
        anchor.appendChild(ctrl.el);
      }
    }
  }

  function step() {
    syncControllers();
    const now = Date.now();
    for (const ctrl of controllers.values()) {
      ctrl.tick(now);
    }
  }

  window.setInterval(step, 500);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", step, { once: true });
  } else {
    step();
  }
})();
