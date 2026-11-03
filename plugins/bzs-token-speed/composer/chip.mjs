// Composer speed chip: injected into ZCode's renderer as a self-contained
// <script> (see scripts/install.mjs). Presentation only — polls the token-speed
// HTTP host every second and renders a chip in the composer toolbar, next to
// the mode selector. No build step, no framework; a tiny state machine plus
// DOM updates. Reuses ZCode's own Tailwind token classes so it tracks theme.
(() => {
  "use strict";
  if (window.__bzsTokenSpeedChip) return;
  window.__bzsTokenSpeedChip = true;

  // ---- tuning ---------------------------------------------------------------
  const POLL_MS = 1000; // sample cadence
  const SPARK_POINTS = 40; // ~40s of history in the sparkline
  const SPARK_W = 44;
  const SPARK_H = 14;
  const STALE_AFTER_MS = 8000; // no fresh data → chip shows "—"
  const MAX_SCALE = 200; // sparkline full-scale; values clamp above

  // chip base: matches ZCode toolbar buttons (h-7, rounded-lg, ghost look)
  const CHIP_CLASS =
    "inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-ui-base text-foreground-subtle select-none";
  const NUM_CLASS = "font-mono tabular-nums text-foreground";
  const TITLE_LINES = ["bzs-token-speed", "最新请求解码速度 / 10 分钟加权"];

  // ---- state ----------------------------------------------------------------
  // samples: ring of {t, v}; latest: most recent tok/s; ok: endpoint reachable
  const state = { ok: false, latest: null, recent: null, streaming: false, lastAt: 0, samples: [] };
  let el = null; // chip root
  let numEl = null; // speed number
  let sparkEl = null; // sparkline polyline
  let retryTimer = 0;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function recordSample(v) {
    const now = Date.now();
    state.samples.push({ t: now, v });
    while (state.samples.length > SPARK_POINTS) state.samples.shift();
  }

  // keep only recent points; gaps (sleep, backend down) age out naturally
  function pruneSamples() {
    const cutoff = Date.now() - SPARK_POINTS * POLL_MS - STALE_AFTER_MS;
    while (state.samples.length > 0 && state.samples[0].t < cutoff) state.samples.shift();
  }

  // ---- rendering --------------------------------------------------------------
  function ensureChip() {
    if (el && el.isConnected) return true;
    const anchor = document.querySelector("[data-composer-leading-content]");
    if (!anchor) return false;
    el = document.createElement("span");
    el.className = CHIP_CLASS;
    el.id = "bzs-token-speed-chip";
    el.title = TITLE_LINES.join("\n");
    el.setAttribute("data-bzs-token-speed", "chip");

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", SPARK_W);
    svg.setAttribute("height", SPARK_H);
    svg.setAttribute("viewBox", `0 0 ${SPARK_W} ${SPARK_H}`);
    svg.setAttribute("aria-hidden", "true");
    svg.style.overflow = "visible";
    svg.style.opacity = "0.75";

    sparkEl = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    sparkEl.setAttribute("fill", "none");
    sparkEl.setAttribute("stroke", "currentColor");
    sparkEl.setAttribute("stroke-width", "1.4");
    sparkEl.setAttribute("stroke-linejoin", "round");
    sparkEl.setAttribute("stroke-linecap", "round");
    svg.appendChild(sparkEl);

    numEl = document.createElement("span");
    numEl.className = NUM_CLASS;
    numEl.textContent = "—";

    el.appendChild(svg);
    el.appendChild(numEl);
    // mode selector sits first; the chip goes after it, before trailing actions
    anchor.appendChild(el);
    return true;
  }

  function sparkPoints() {
    pruneSamples();
    const pts = state.samples;
    if (pts.length < 2) return "";
    const n = pts.length;
    const t0 = pts[0].t, t1 = pts[n - 1].t;
    const span = Math.max(1, t1 - t0);
    return pts
      .map(({ t, v }) => {
        const x = ((t - t0) / span) * (SPARK_W - 2) + 1;
        const y = SPARK_H - 2 - clamp(v / MAX_SCALE, 0, 1) * (SPARK_H - 4);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }

  function render() {
    if (!ensureChip()) return;
    const fresh = state.ok && Date.now() - state.lastAt < STALE_AFTER_MS;
    const hasSpeed = fresh && state.latest != null;
    numEl.textContent = hasSpeed ? state.latest.toFixed(1) : "—";
    el.title = [
      "bzs-token-speed",
      hasSpeed ? `最新请求：${state.latest.toFixed(1)} tok/s` : "等待模型流量…",
      state.recent != null ? `近 10 分钟加权：${state.recent.toFixed(1)} tok/s` : null,
    ]
      .filter(Boolean)
      .join("\n");
    // streaming gets full emphasis; idle stays subtle
    el.style.opacity = state.streaming && hasSpeed ? "1" : "0.72";
    const pts = fresh ? sparkPoints() : "";
    if (pts) sparkEl.setAttribute("points", pts);
    else sparkEl.removeAttribute("points");
  }

  // ---- polling -----------------------------------------------------------------
  // Single endpoint: /api/snapshot resolves the session server-side; the chip
  // stays dumb. Failures back off to a slow retry so a stopped backend never
  // spins the renderer.
  async function poll(base) {
    try {
      const res = await fetch(`${base}/api/snapshot`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const snap = await res.json();
      const s = snap.summary;
      state.ok = true;
      state.lastAt = Date.now();
      state.latest = s ? s.latestTokPerSec : null;
      state.recent = s ? (s.recent10m ?? s.overall ?? null) : null;
      state.streaming = !!s?.streaming;
      if (s && s.latestTokPerSec != null) recordSample(s.latestTokPerSec);
    } catch {
      state.ok = false;
      return false;
    }
    return true;
  }

  // install.mjs embeds the endpoint as a <meta>; the <html data-...> attribute
  // is the manual-override path. Both are read once here.
  function endpointBase() {
    return (
      document.documentElement.getAttribute("data-bzs-token-speed-base") ??
      document.querySelector('meta[name="bzs-token-speed-base"]')?.content ??
      null
    );
  }

  // Endpoint candidates, tried in order until one answers. The baked <meta>
  // goes stale when the MCP process rebinds to a random port after a restart;
  // the fixed preferred port stays stable, so it is the main fallback.
  const FALLBACK_BASES = ["http://127.0.0.1:47816"];
  let activeBase = null;

  function startPolling() {
    const base = activeBase ?? endpointBase();
    if (!base) {
      retryTimer = window.setTimeout(startPolling, 3000);
      return;
    }
    (async () => {
      let alive = await poll(base);
      if (alive) {
        activeBase = base; // keep the working endpoint; meta stays a fallback
      } else {
        activeBase = null;
        for (const candidate of FALLBACK_BASES) {
          if (candidate !== base && (await poll(candidate))) {
            activeBase = candidate;
            alive = true;
            break;
          }
        }
      }
      render();
      retryTimer = window.setTimeout(startPolling, alive ? POLL_MS : 5000);
    })();
  }

  // The renderer may rebuild the toolbar (route switches, composer mount).
  // Re-render on an interval also re-attaches the chip after unmount.
  window.setInterval(render, POLL_MS);
  startPolling();
})();
