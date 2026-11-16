(function () {
  "use strict";

  var C = window.ScopeColor, A = window.ScopeAnalyze, R = window.ScopeRender, Vw = window.ScopeView;
  var PREF_KEY = "ae-scopes.prefs";

  /* ── preferences ──────────────────────────────────────────────── */

  var DEFAULTS = {
    cells: [{ k: "waveform", m: "parade" }, { k: "vector" }, { k: "histogram" }, { k: "image", m: "none" }],
    layout: "auto", mode: "auto", quality: 480, units: "pct", vzoom: 1, intensity: 1, colorTrace: true, histLog: false, info: "full", zebra: 95,
    space: "rec709", transfer: "auto", scale: "display", range: "auto", ocioWork: "auto", ocioView: "srgb",
  };

  function loadPrefs() {
    var p = JSON.parse(JSON.stringify(DEFAULTS));
    try {
      var raw = JSON.parse(window.localStorage.getItem(PREF_KEY) || "{}");
      for (var k in raw) { if (raw.hasOwnProperty(k) && DEFAULTS.hasOwnProperty(k)) { p[k] = raw[k]; } }
      if (!(p.cells instanceof Array) || p.cells.length < 4) { p.cells = DEFAULTS.cells.slice(0); }
    } catch (e) { /* first run */ }
    return p;
  }
  var P = loadPrefs();
  function savePrefs() { try { window.localStorage.setItem(PREF_KEY, JSON.stringify(P)); } catch (e) { /* ignore */ } }

  /* ── state ────────────────────────────────────────────────────── */

  var S = { empty: null, decoded: null, settings: null, snap: null, frame: null, desc: null, range: 1, roi: null, hover: null, cache: {}, ver: 0, timing: null, lastError: "", cells: [], count: 0 };
  var el = {};
  var raf = 0, pendingAll = false, pendingCells = {};
  var V = [];                                   // zoom window per cell index (null = whole scope); lives for the session, survives new frames
  var drag = null;                              // active mouse drag: { mode: "roi" | "pan", i, ... }
  var hot = { i: -1, u: 0.5, w: 0.5 };          // cell under the cursor + cursor position inside its plot (for the +/- keys)
  var spaceDown = false;

  /* ── helpers ──────────────────────────────────────────────────── */

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  function copyText(text, cb) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.left = "-9999px";
      document.body.appendChild(ta); ta.select();
      var ok = document.execCommand("copy"); document.body.removeChild(ta); cb(ok);
    } catch (e) { cb(false); }
  }

  function userColor() {
    return {
      scale: P.scale, space: P.space, transfer: P.transfer === "auto" ? undefined : P.transfer,
      ocioWorking: P.ocioWork === "auto" ? undefined : P.ocioWork, ocioView: P.ocioView,
    };
  }

  // value (view units, 1.0 = 100%) formatted for the chosen units
  function fv(v, units) {
    units = units || P.units;
    if (v === null || v === undefined || isNaN(v)) { return "–"; }
    if (units === "8bit") { return String(Math.round(v * 255)); }
    if (units === "10bit") { return String(Math.round(v * 1023)); }
    if (units === "float") { return v.toFixed(3); }
    return (v * 100).toFixed(1) + "%";
  }
  function pct(v, d) { return (v * 100).toFixed(d === undefined ? 1 : d) + "%"; }

  /* ── analysis cache ───────────────────────────────────────────── */

  function roiKey() { return S.roi ? [S.roi.x, S.roi.y, S.roi.w, S.roi.h].join(",") : "full"; }
  function coefName() { return S.desc ? S.desc.coef : "rec709"; }
  function memo(key, fn) { if (!S.cache[key]) { S.cache[key] = fn(); } return S.cache[key]; }

  /* ── layout ───────────────────────────────────────────────────── */

  function layoutPlan() {
    var W = el.grid.clientWidth, H = el.grid.clientHeight, L = P.layout;
    if (L === "auto") {
      if (W < 200 || H < 130) { L = "1"; }
      else if (W >= 520 && H >= 300) { L = "4"; }
      else if (W >= H * 1.25) { L = "2h"; }
      else { L = "2v"; }
    }
    return { "1": { n: 1, c: 1, r: 1 }, "2h": { n: 2, c: 2, r: 1 }, "2v": { n: 2, c: 1, r: 2 }, "4": { n: 4, c: 2, r: 2 } }[L];
  }

  var KINDS = [
    { id: "waveform:luma", name: "Waveform · Luma", short: "Luma" },
    { id: "waveform:rgb", name: "Waveform · RGB", short: "RGB" },
    { id: "waveform:parade", name: "Waveform · RGB Parade", short: "Parade" },
    { id: "waveform:ycbcr", name: "Waveform · YCbCr Parade", short: "YCbCr" },
    { sep: true },
    { id: "vector", name: "Vectorscope", short: "Vectorscope" },
    { id: "histogram", name: "Histogram", short: "Histogram" },
    { id: "cie", name: "CIE 1931 xy", short: "CIE xy" },
    { sep: true },
    { id: "image:none", name: "Image", short: "Image" },
    { id: "image:false", name: "Image · False Color", short: "False Color" },
    { id: "image:zebra", name: "Image · Zebra", short: "Zebra" },
    { id: "image:clip", name: "Image · Clipping", short: "Clipping" },
  ];
  function kindId(c) { return c.m ? c.k + ":" + c.m : c.k; }
  function kindName(c) { for (var i = 0; i < KINDS.length; i++) { if (KINDS[i].id === kindId(c)) { return KINDS[i].short; } } return "Scope"; }

  function buildCells() {
    var plan = layoutPlan();
    el.grid.style.gridTemplateColumns = "repeat(" + plan.c + ", minmax(0, 1fr))";
    el.grid.style.gridTemplateRows = "repeat(" + plan.r + ", minmax(0, 1fr))";
    if (S.count === plan.n && S.cells.length === plan.n) { return; }
    el.grid.innerHTML = "";
    S.cells = []; S.count = plan.n;
    for (var i = 0; i < plan.n; i++) {
      var sec = document.createElement("section");
      sec.className = "cell"; sec.setAttribute("data-cell", i);
      sec.innerHTML = '<header class="cell__head"><button type="button" class="cell__title" data-action="cell-menu" data-cell="' + i + '" aria-haspopup="menu" aria-expanded="false" title="Choose the scope. Scroll over a scope to zoom, drag to pan, double-click to reset.">' +
        '<span class="cell__name"></span><svg width="7" height="7" viewBox="0 0 8 8" aria-hidden="true"><path d="M1.5 2.8 4 5.4l2.5-2.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></button>' +
        '<span class="cell__right"><span class="cell__meta"></span>' +
        '<button type="button" class="cell__zoom" data-action="view-reset" data-cell="' + i + '" hidden title="Reset zoom and position (or double-click the scope)">' +
        '<span class="cell__zval"></span><svg width="9" height="9" viewBox="0 0 12 12" aria-hidden="true"><path d="M10 6a4 4 0 1 1-1.2-2.85" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M9.4 1v2.4H7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button></span></header>' +
        '<div class="cell__body"><canvas></canvas></div>';
      el.grid.appendChild(sec);
      var cv = sec.querySelector("canvas");
      S.cells.push({ root: sec, canvas: cv, name: sec.querySelector(".cell__name"), meta: sec.querySelector(".cell__meta"), zoomBtn: sec.querySelector(".cell__zoom"), zval: sec.querySelector(".cell__zval"), geo: null });
      bindCanvas(i);
    }
    S.cells.forEach(refreshTitle);
    S.cells.forEach(function (c, i) { updateZoomUI(i); });
    if (window.ResizeObserver) {
      if (!S.ro) { S.ro = new ResizeObserver(function () { scheduleAll(); }); }
      S.ro.disconnect(); S.ro.observe(el.grid); S.cells.forEach(function (c) { S.ro.observe(c.root); });
    }
    scheduleAll();
  }

  function refreshTitle(cell, i) {
    var c = P.cells[i]; cell.name.textContent = kindName(c);
    cell.canvas.className = (c.k === "image" ? "is-image" : "") + (V[i] ? " is-zoomed" : "");
  }

  /* ── zoom / pan ───────────────────────────────────────────────── */

  function viewOf(i) { return V[i] || Vw.full(); }
  function updateZoomUI(i) {
    var cell = S.cells[i]; if (!cell) { return; }
    var v = V[i];
    cell.zoomBtn.hidden = !v;
    if (v) {
      cell.zval.textContent = Vw.label(v);
      cell.zoomBtn.title = "Zoom " + Vw.label(v) + " - click to reset zoom and position (or double-click the scope)";
    }
    refreshTitle(cell, i);
  }
  function setView(i, v) {
    V[i] = Vw.isFull(v) ? null : v;
    updateZoomUI(i); scheduleCell(i);
  }
  function resetView(i) { if (V[i]) { V[i] = null; updateZoomUI(i); scheduleCell(i); } if (S.cells[i]) { S.cells[i].meta.textContent = ""; } }
  function resetAllViews() { var any = false; for (var i = 0; i < V.length; i++) { if (V[i]) { any = true; } V[i] = null; } S.cells.forEach(function (c, i) { updateZoomUI(i); }); scheduleAll(); return any; }

  // which axes a wheel turn zooms, per scope
  function wheelAxes(k, ev) {
    if (k === "waveform") { return ev.shiftKey ? "x" : ((ev.ctrlKey || ev.altKey) ? "y" : "xy"); }
    if (k === "histogram") { return (ev.ctrlKey || ev.altKey) ? "y" : "x"; }
    return "xy";                                                  // vectorscope / CIE / image keep their aspect
  }
  function fixHistogramView(v) { var h = v.y1 - v.y0; v.y0 = 1 - h; v.y1 = 1; return v; }       // the histogram only gains height, anchored at the bottom

  function zoomCell(i, u, w, f, axes) {
    var k = P.cells[i].k, nv = Vw.zoom(viewOf(i), u, w, f, f, axes);
    if (k === "histogram") { fixHistogramView(nv); }
    setView(i, nv);
  }

  function plotFrac(cell, ev) {
    var g = cell.geo; if (!g || !g.plot) { return null; }
    var r = cell.canvas.getBoundingClientRect(), pl = g.plot;
    return { u: Math.max(0, Math.min(1, (ev.clientX - r.left - pl.x) / pl.w)), w: Math.max(0, Math.min(1, (ev.clientY - r.top - pl.y) / pl.h)) };
  }

  /* ── drawing ──────────────────────────────────────────────────── */

  function scheduleAll() { pendingAll = true; if (!raf) { raf = requestAnimationFrame(flush); } }
  function scheduleCell(i) { pendingCells[i] = true; if (!raf) { raf = requestAnimationFrame(flush); } }
  function renderEmpty() {
    var e = S.empty;
    if (el.grid.getAttribute("data-empty") === e.title) { return; }
    el.grid.setAttribute("data-empty", e.title);
    el.grid.style.gridTemplateColumns = "1fr"; el.grid.style.gridTemplateRows = "1fr";
    el.grid.innerHTML = '<div class="grid-empty"><p class="grid-empty__title">' + esc(e.title) + '</p><p class="grid-empty__hint">' + esc(e.hint) + "</p></div>";
    S.cells = []; S.count = 0;
  }

  function flush() {
    raf = 0;
    if (S.empty) { pendingAll = false; pendingCells = {}; renderEmpty(); return; }
    if (el.grid.hasAttribute("data-empty")) { el.grid.removeAttribute("data-empty"); S.count = 0; el.grid.innerHTML = ""; }
    if (pendingAll) { pendingAll = false; pendingCells = {}; buildCells(); for (var i = 0; i < S.cells.length; i++) { drawCell(i); } afterDraw(); return; }
    for (var k in pendingCells) { if (pendingCells.hasOwnProperty(k)) { drawCell(Number(k)); } }
    pendingCells = {};
    afterDraw();
  }

  // the information bar is the least urgent thing on screen: build it after the scopes have been drawn, not before
  function afterDraw() { if (S.infoDirty) { S.infoDirty = false; setTimeout(updateInfo, 0); } }

  function drawCell(i) {
    var cell = S.cells[i]; if (!cell) { return; }
    var c = P.cells[i], cv = cell.canvas;
    if (!S.frame) { R.fit(cv); cell.geo = null; return; }
    var f = S.frame, roi = S.roi, coef = coefName(), rk = roiKey(), dpr = window.devicePixelRatio || 1;
    var vw = viewOf(i), vk = Vw.key(vw), compW = S.snap && S.snap.comp ? S.snap.comp.w : f.w;
    if (c.k === "waveform") {
      var cols = Math.max(128, Math.min(768, Math.round(cv.clientWidth * dpr * 0.9)));
      var rows = vw.y1 - vw.y0 < 0.9999 ? Math.max(128, Math.min(512, Math.round(cv.clientHeight * dpr * 0.9))) : (S.range > 1 ? 384 : 256);                    // zoomed in vertically: finer level bins
      var wf = memo("wf|" + c.m + "|" + S.range + "|" + cols + "|" + rows + "|" + rk + "|" + coef + "|" + vk, function () { return A.waveform(f, { mode: c.m, cols: cols, rows: rows, range: S.range, coef: coef, win: vw }, roi); });
      cell.geo = R.waveform(cv, wf, { units: P.units, intensity: P.intensity, range: S.range, view: V[i], compW: compW }); cell.geo.kind = "waveform";
    } else if (c.k === "vector") {
      var vsz = V[i] ? 320 : 256;
      var vs = memo("vs|" + P.vzoom + "|" + rk + "|" + coef + "|" + vk, function () { return A.vectorscope(f, { size: vsz, zoom: Number(P.vzoom), coef: coef, win: vw }, roi); });
      cell.geo = R.vector(cv, vs, { intensity: P.intensity, colorTrace: P.colorTrace, coef: coef, zoom: Number(P.vzoom), view: V[i] }); cell.geo.kind = "vector";
    } else if (c.k === "histogram") {
      var hw = { x0: vw.x0, x1: vw.x1, y0: 0, y1: 1 }, hk = hw.x0.toFixed(4) + "," + hw.x1.toFixed(4);
      var hg = memo("hg|" + S.range + "|" + rk + "|" + coef + "|" + hk, function () { return A.histogram(f, { bins: 256, range: S.range, coef: coef, win: hw }, roi); });
      cell.geo = R.histogram(cv, hg, { units: P.units, log: P.histLog, gain: 1 / (vw.y1 - vw.y0), view: V[i] }); cell.geo.kind = "histogram"; cell.geo.hg = hg;
    } else if (c.k === "cie") {
      var ci = memo("ci|" + rk + "|" + vk, function () { return A.cie(f, { size: V[i] ? 320 : 256, win: vw }, roi); });
      cell.geo = R.cie(cv, ci, { view: V[i] }); cell.geo.kind = "cie";
    } else if (c.k === "image") {
      var ovKey = "ov|" + (c.m || "none") + "|" + (c.m === "zebra" ? P.zebra : "") + "|" + coef;
      var ov = memo(ovKey, function () {
        if (c.m === "false") { return { base: A.falseColor(f, { coef: coef }), layer: null }; }
        if (c.m === "zebra") { return { base: A.toRGBA(f), layer: A.zebra(f, { coef: coef, hi: Number(P.zebra) }) }; }
        if (c.m === "clip") { return { base: A.toRGBA(f), layer: A.clipMask(f) }; }
        return { base: A.toRGBA(f), layer: null };
      });
      cell.geo = R.image(cv, f, ov, S.roi, S.hover && S.hover.src === i ? S.hover : null, { view: V[i], key: S.ver + "|" + ovKey }); cell.geo.kind = "image";
    }
  }

  /* ── info strip ───────────────────────────────────────────────── */

  function updateInfo() {
    var info = el.info;
    if (P.info === "off") { info.hidden = true; return; }
    info.hidden = false;
    if (!S.frame) { info.innerHTML = '<div class="info__row"><span class="info__tag">waiting</span></div>'; return; }
    var f = S.frame, coef = coefName(), full = P.info === "full";
    var hov = S.hover, px;
    var st = memo("st|" + roiKey() + "|" + coef, function () { return A.stats(f, { coef: coef }, S.roi); });
    if (hov) { px = A.pixelAt(f, hov.x, hov.y, coef); }
    var swatch, tag, rgb;
    if (px) { swatch = px.hex; tag = "Sample " + Math.round(hov.x) + "," + Math.round(hov.y); rgb = [px.r, px.g, px.b]; }
    else { swatch = st.avgHex; tag = S.roi ? "ROI average" : "Average"; rgb = [st.r.mean, st.g.mean, st.b.mean]; }
    var avgPx = px || (function () {            // average colour as a pseudo-pixel for HSL/Lab
      var m = new Float32Array(3), l = new Float32Array(3);
      var ap = { w: 1, h: 1, view: m, lin: l, alpha: null, prim: f.prim };
      m[0] = st.r.mean; m[1] = st.g.mean; m[2] = st.b.mean;
      var tf = C.tfFor(S.desc.displayTrc); l[0] = tf.eotf(m[0]); l[1] = tf.eotf(m[1]); l[2] = tf.eotf(m[2]);
      var ml = C.gamutMatrix(S.desc.displayPrim, f.prim); var lr = ml[0] * l[0] + ml[1] * l[1] + ml[2] * l[2], lg = ml[3] * l[0] + ml[4] * l[1] + ml[5] * l[2], lb = ml[6] * l[0] + ml[7] * l[1] + ml[8] * l[2];
      l[0] = lr; l[1] = lg; l[2] = lb;
      return A.pixelAt(ap, 0, 0, coef);
    })();
    var yv = px ? px.y : st.luma.mean;
    var lab = avgPx.lab ? avgPx.lab.map(function (v) { return v.toFixed(0); }).join(" ") : "–";
    var xy = avgPx.xy ? avgPx.xy[0].toFixed(3) + " " + avgPx.xy[1].toFixed(3) : "–";
    var h = '<div class="info__row"><span class="info__swatch" style="background:' + swatch + '"></span><span class="info__tag">' + tag + "</span>" +
      "<span><b>R</b>" + fv(rgb[0]) + "</span><span><b>G</b>" + fv(rgb[1]) + "</span><span><b>B</b>" + fv(rgb[2]) + "</span><span>" + esc(swatch.toUpperCase()) + "</span></div>";
    h += '<div class="info__row info__row--extra"><span><b>Y</b>' + fv(yv) + "</span><span><b>H</b>" + avgPx.h.toFixed(0) + "°</span><span><b>S</b>" + pct(avgPx.sHsl, 0) + "</span><span><b>L</b>" + pct(avgPx.l, 0) + "</span>" +
      "<span><b>Lab</b>" + lab + "</span><span><b>xy</b>" + xy + "</span></div>";
    if (full) {
      var flags = "";
      if (st.over > 0.0005) { flags += '<span class="info__hot"><b>Over</b>' + pct(st.over) + " · +" + st.stopsOver.toFixed(1) + " st</span>"; }
      if (st.negative > 0.0005) { flags += '<span class="info__warn"><b>Neg</b>' + pct(st.negative) + "</span>"; }
      h += '<div class="info__row info__row--extra"><span><b>Luma</b>' + fv(st.luma.min) + " – " + fv(st.luma.max) + "</span><span><b>Med</b>" + fv(st.luma.median) + "</span>" +
        '<span class="' + (st.clipHi > 0.001 ? "info__warn" : "") + '"><b>Clip ▲</b>' + pct(st.clipHi) + '</span><span class="' + (st.clipLo > 0.05 ? "info__cold" : "") + '"><b>▼</b>' + pct(st.clipLo) + "</span>" +
        "<span><b>Sat</b>" + pct(st.saturation, 0) + "</span>" + flags + "</div>";
      var pal = memo("pal|" + roiKey(), function () { return A.palette(f, 5, S.roi); });
      h += '<div class="palette" title="Dominant colours - click to copy a hex value">' + pal.map(function (p) {
        return '<span class="palette__chip" data-action="copy-hex" data-hex="' + p.hex + '" style="background:' + p.hex + ';flex-grow:' + Math.max(0.3, p.share * 10).toFixed(2) + '" title="' + p.hex.toUpperCase() + " · " + (p.share * 100).toFixed(0) + '%"></span>';
      }).join("") + "</div>";
    }
    info.innerHTML = h;
  }

  /* ── top bar / badge ──────────────────────────────────────────── */

  function updateChips() {
    var snap = S.snap, label;
    if (snap && snap.kind === "comp" && snap.comp) {
      var c = snap.comp;
      label = "<strong>" + esc(c.name) + "</strong> <span>" + c.w + "×" + c.h + " · f" + c.frame + "</span>";
    }
    else { label = "<span>Open a composition</span>"; }
    el.compLabel.innerHTML = label;
    if (S.timing) {
      el.compChip.title = "Last update: After Effects render + write " + S.timing.capture + " ms · decode " + S.timing.decode + " ms · colour " + (S.timing.analysis || 0) +
        " ms" + (S.timing.poll ? " · poll round trip " + S.timing.poll + " ms" : "");
    }

    if (S.desc) {
      el.badgeText.textContent = S.desc.label;
      var rg = S.frame ? memo("rg|" + roiKey(), function () { return A.range(S.frame, S.roi); }) : null;
      el.badgeHdr.hidden = !(rg && rg.over > 0.0005);
      if (rg && rg.over > 0.0005) { el.badgeHdr.textContent = "HDR · " + Math.round(rg.max * 100) + "%"; }
      var notes = S.desc.notes || [];
      el.badgeNote.hidden = !notes.length;
      el.badge.title = notes.length ? notes.join("\n") : "Colour pipeline - click to change";
    }
    if (!S.desc) {
      el.badgeText.textContent = "Colour pipeline: waiting for a composition";
      el.badgeHdr.hidden = true; el.badgeNote.hidden = true; el.badge.title = "Colour pipeline - click to change";
    }
    el.roiChip.hidden = !S.roi;
    if (S.roi) { el.roiLabel.textContent = "ROI " + S.roi.w + "×" + S.roi.h; }
  }

  function setDot(state) { el.dot.setAttribute("data-state", state); }

  /* ── frames ───────────────────────────────────────────────────── */

  function processFrame() {
    var t0 = Date.now();
    var desc = C.describe(S.settings, userColor());
    var frame = C.process(S.decoded, desc); frame.prim = desc.working.prim;
    S.desc = desc; S.frame = frame;
    S.range = P.range === "auto" ? A.autoRange(A.range(frame, S.roi)) : Number(P.range);
    S.cache = {}; S.ver++;
    return Date.now() - t0;
  }

  function onFrame(payload) {
    S.empty = null;
    S.decoded = payload.decoded; S.settings = payload.settings; S.snap = payload.snap;
    var tp = processFrame();
    S.timing = payload.timing || {}; S.timing.analysis = tp;
    if (S.roi && (S.roi.x + S.roi.w > S.frame.w || S.roi.y + S.roi.h > S.frame.h)) { S.roi = null; S.cache = {}; }
    afterUpdate();
  }

  function reprocess() { if (!S.decoded) { scheduleAll(); return; } processFrame(); afterUpdate(); }

  function afterUpdate() { updateChips(); S.infoDirty = true; scheduleAll(); syncModal(); }

  /* ── interaction ──────────────────────────────────────────────── */

  function toFramePx(cell, ev) {
    var g = cell.geo; if (!g || g.kind !== "image") { return null; }
    var r = cell.canvas.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top;
    if (x < g.vx || y < g.vy || x >= g.vx + g.vw || y >= g.vy + g.vh) { return null; }          // outside the picture window
    var fx = (x - g.dx) / g.scale, fy = (y - g.dy) / g.scale;
    if (fx < 0 || fy < 0 || fx >= S.frame.w || fy >= S.frame.h) { return null; }
    return { x: fx, y: fy };
  }

  function bindCanvas(i) {
    var cell = S.cells[i], cv = cell.canvas;

    cv.addEventListener("mousedown", function (ev) {
      if (!S.frame || !cell.geo) { return; }
      var k = P.cells[i].k, zoomed = !!V[i];
      // pan: middle button, Space/Alt + drag, or plain drag once zoomed (images keep Shift + drag for the region of interest)
      var wantPan = ev.button === 1 || (ev.button === 0 && (spaceDown || ev.altKey || (zoomed && !(k === "image" && ev.shiftKey))));
      if (wantPan) {
        if (!cell.geo.plot) { return; }
        drag = { mode: "pan", i: i, x: ev.clientX, y: ev.clientY, v: viewOf(i) };
        cv.classList.add("is-panning"); ev.preventDefault(); return;
      }
      if (ev.button !== 0 || k !== "image") { return; }
      var p = toFramePx(cell, ev); if (!p) { return; }
      drag = { mode: "roi", i: i, x0: p.x, y0: p.y, moved: false };
      ev.preventDefault();
    });

    cv.addEventListener("wheel", function (ev) {
      if (!S.frame || !cell.geo || !cell.geo.plot) { return; }
      ev.preventDefault();
      var dy = ev.deltaY || ev.deltaX;                                       // Shift + wheel arrives as deltaX in Chromium on Windows
      if (ev.deltaMode === 1) { dy *= 33; } else if (ev.deltaMode === 2) { dy *= 400; }
      dy = Math.max(-400, Math.min(400, dy));
      if (!dy) { return; }
      var pf = plotFrac(cell, ev); if (!pf) { return; }
      zoomCell(i, pf.u, pf.w, Math.exp(-dy * 0.0022), wheelAxes(P.cells[i].k, ev));
    }, { passive: false });

    cv.addEventListener("mouseenter", function () { hot.i = i; if (spaceDown) { cv.classList.add("is-hand"); } });
    cv.addEventListener("mousemove", function (ev) {
      hot.i = i; var pf = plotFrac(cell, ev); if (pf) { hot.u = pf.u; hot.w = pf.w; }
      if (!S.frame || drag) { return; }
      var k = P.cells[i].k;
      if (k === "image") {
        var p = toFramePx(cell, ev);
        S.hover = p ? { x: Math.floor(p.x), y: Math.floor(p.y), src: i } : null;
        updateInfo(); scheduleCell(i);
        cell.meta.textContent = p ? "x " + Math.floor(p.x) + "  y " + Math.floor(p.y) : "";
      } else { hoverReadout(cell, k, ev); }
    });
    cv.addEventListener("mouseleave", function () {
      if (hot.i === i) { hot.i = -1; }
      cv.classList.remove("is-hand");
      if (S.hover && S.hover.src === i) { S.hover = null; updateInfo(); scheduleCell(i); }
      if (!drag) { cell.meta.textContent = ""; }
    });
    cv.addEventListener("dblclick", function () {
      if (P.cells[i].k === "image" && S.roi) { clearRoi(); } else { resetView(i); }
    });
  }

  // drags are tracked on the window so they keep working when the cursor leaves the canvas (installed once)
  function bindDrag() {
    window.addEventListener("mousemove", function (ev) {
      if (!drag) { return; }
      var cell = S.cells[drag.i]; if (!cell) { drag = null; return; }
      if (drag.mode === "pan") {
        var pl = cell.geo && cell.geo.plot; if (!pl) { return; }
        var k = P.cells[drag.i].k, dv = k === "histogram" ? 0 : (ev.clientY - drag.y) / pl.h;
        setView(drag.i, Vw.pan(drag.v, (ev.clientX - drag.x) / pl.w, dv));
        return;
      }
      var r = cell.canvas.getBoundingClientRect(), g = cell.geo;
      var fx = Math.max(0, Math.min(S.frame.w, (ev.clientX - r.left - g.dx) / g.scale)), fy = Math.max(0, Math.min(S.frame.h, (ev.clientY - r.top - g.dy) / g.scale));
      var x = Math.min(drag.x0, fx), y = Math.min(drag.y0, fy), w = Math.abs(fx - drag.x0), h = Math.abs(fy - drag.y0);
      if (w > 2 || h > 2) { drag.moved = true; drag.tmp = { x: Math.floor(x), y: Math.floor(y), w: Math.max(2, Math.ceil(w)), h: Math.max(2, Math.ceil(h)) }; S.hover = null; var keep = S.roi; S.roi = drag.tmp; scheduleCell(drag.i); S.roi = keep; }
    });
    window.addEventListener("mouseup", function () {
      if (!drag) { return; }
      var d = drag; drag = null;
      var cell = S.cells[d.i]; if (cell) { cell.canvas.classList.remove("is-panning"); }
      if (d.mode === "pan") { return; }
      if (d.moved && d.tmp && d.tmp.w > 4 && d.tmp.h > 4) { S.roi = d.tmp; S.cache = {}; S.range = P.range === "auto" ? A.autoRange(A.range(S.frame, S.roi)) : Number(P.range); updateChips(); updateInfo(); scheduleAll(); }
      else { scheduleCell(d.i); }
    });
    window.addEventListener("blur", function () { drag = null; spaceDown = false; });
  }

  function hoverReadout(cell, k, ev) {
    var g = cell.geo; if (!g) { return; }
    var r = cell.canvas.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top, t = "";
    if (k === "waveform") {
      if (y >= g.mt && y <= g.mt + g.ph && x >= g.ml && x <= g.ml + g.pw) {
        var v = (g.t0 + (1 - (y - g.mt) / g.ph) * (g.t1 - g.t0)) * g.range;
        t = fv(v) + (P.units === "pct" ? "" : "  (" + (v * 100).toFixed(1) + "%)");
        var cw = S.snap && S.snap.comp ? S.snap.comp.w : (S.frame ? S.frame.w : 0), local = ((x - g.ml) / g.pw * g.panels) % 1;
        if (cw) { t += "  ·  x " + Math.min(cw - 1, Math.floor((g.x0 + local * (g.x1 - g.x0)) * cw)); }
      }
    } else if (k === "vector") {
      var cb = (x - g.cx) / g.scale, cr = -(y - g.cy) / g.scale, mag = Math.sqrt(cb * cb + cr * cr);
      var ang = (Math.atan2(cr, cb) * 180 / Math.PI + 360) % 360;
      var inside = g.zoomed ? (x >= g.ox && x <= g.ox + g.size && y >= g.oy && y <= g.oy + g.size) : mag * g.scale <= g.R;
      if (inside) { t = "∠ " + ang.toFixed(0) + "°   sat " + (mag / 0.5 * 100).toFixed(0) + "%"; }
    } else if (k === "cie" && g.w) {
      if (x >= g.ox && x <= g.ox + g.w && y >= g.oy && y <= g.oy + g.h) {
        var cx = (x - g.ox) / g.w * (g.bounds[1] - g.bounds[0]) + g.bounds[0], cy = (1 - (y - g.oy) / g.h) * (g.bounds[3] - g.bounds[2]) + g.bounds[2];
        t = "x " + cx.toFixed(3) + "  y " + cy.toFixed(3);
      }
    } else if (k === "histogram" && g.hg) {
      var u = (x - g.ml) / g.pw;
      if (u >= 0 && u <= 1) {
        var idx = Math.round(u * (g.hg.bins - 1)), val = (g.x0 + u * (g.x1 - g.x0)) * g.hg.range;
        t = fv(val) + "  ·  " + Math.round(g.hg.y[idx]) + " px";
      }
    }
    cell.meta.textContent = t;
  }

  function clearRoi() { S.roi = null; S.cache = {}; if (S.frame) { S.range = P.range === "auto" ? A.autoRange(A.range(S.frame, null)) : Number(P.range); } updateChips(); updateInfo(); scheduleAll(); }

  /* ── menus ────────────────────────────────────────────────────── */

  function closeMenus() {
    el.menu.hidden = true; el.btnSettings.setAttribute("aria-expanded", "false");
    el.cellMenu.hidden = true;
    var open = document.querySelector('.cell__title[aria-expanded="true"]'); if (open) { open.setAttribute("aria-expanded", "false"); }
  }

  function openCellMenu(btn) {
    var i = Number(btn.getAttribute("data-cell")), cur = kindId(P.cells[i]);
    if (!el.cellMenu.hidden && btn.getAttribute("aria-expanded") === "true") { closeMenus(); return; }
    closeMenus();
    el.cellMenu.innerHTML = KINDS.map(function (k) {
      if (k.sep) { return '<div class="settings-menu__sep" role="separator"></div>'; }
      return '<button type="button" class="settings-menu__item" role="menuitemradio" aria-checked="' + (k.id === cur) + '" data-action="pick-kind" data-cell="' + i + '" data-kind="' + k.id + '">' + esc(k.name) + "</button>";
    }).join("");
    var r = btn.getBoundingClientRect();
    el.cellMenu.hidden = false;
    var mw = el.cellMenu.offsetWidth, mh = el.cellMenu.offsetHeight;
    el.cellMenu.style.left = Math.max(2, Math.min(window.innerWidth - mw - 2, r.left)) + "px";
    el.cellMenu.style.top = Math.max(2, Math.min(window.innerHeight - mh - 2, r.bottom + 2)) + "px";
    btn.setAttribute("aria-expanded", "true");
  }

  function setMode(m) {
    P.mode = m; savePrefs();
    var items = el.menu.querySelectorAll('[data-action="mode"]');
    for (var i = 0; i < items.length; i++) { items[i].setAttribute("aria-checked", items[i].getAttribute("data-mode") === m ? "true" : "false"); }
    if (window.ScopeCapture) { window.ScopeCapture.refresh(); }
  }

  /* ── settings modal ───────────────────────────────────────────── */

  var MODAL_MAP = [
    ["opt-space", "space"], ["opt-transfer", "transfer"], ["opt-scale", "scale"], ["opt-range", "range"], ["opt-ocio-work", "ocioWork"], ["opt-ocio-view", "ocioView"],
    ["opt-layout", "layout"], ["opt-quality", "quality"], ["opt-units", "units"], ["opt-vzoom", "vzoom"], ["opt-info", "info"],
  ];

  function syncModal() {
    MODAL_MAP.forEach(function (m) { var e = $(m[0]); if (e && document.activeElement !== e) { e.value = String(P[m[1]]); } });
    $("opt-intensity").value = P.intensity; $("opt-zebra").value = P.zebra; $("opt-colortrace").checked = !!P.colorTrace; $("opt-histlog").checked = !!P.histLog;
    var ocio = S.settings && S.settings.cms === 1;
    $("row-ocio-work").hidden = !ocio; $("row-ocio-view").hidden = !ocio;
    $("pipeline-label").textContent = S.desc ? S.desc.label : "Waiting for a frame…";
    var notes = S.desc && S.desc.notes && S.desc.notes.length ? S.desc.notes : null;
    var n = $("pipeline-notes"); n.hidden = !notes; n.textContent = notes ? notes.join("  ") : "";
  }

  function openModal(section) {
    syncModal();
    el.modal.hidden = false; el.modal.setAttribute("aria-hidden", "false");
    var target = $(section === "color" ? "sec-color" : "sec-display");
    if (target) { target.scrollIntoView({ block: "start" }); }
  }
  function closeModal() { el.modal.hidden = true; el.modal.setAttribute("aria-hidden", "true"); }

  function bindModal() {
    MODAL_MAP.forEach(function (m) {
      $(m[0]).addEventListener("change", function () {
        var v = this.value; P[m[1]] = (m[1] === "quality") ? Number(v) : v; savePrefs();
        if (m[1] === "quality") { window.ScopeCapture.refresh(); return; }
        if (m[1] === "layout") { S.count = 0; scheduleAll(); return; }
        if (m[1] === "units" || m[1] === "vzoom" || m[1] === "info") { S.cache = {}; updateInfo(); scheduleAll(); return; }
        reprocess();                                              // colour options change the pipeline
      });
    });
    $("opt-intensity").addEventListener("input", function () { P.intensity = Number(this.value); savePrefs(); scheduleAll(); });
    $("opt-zebra").addEventListener("input", function () { P.zebra = Number(this.value); savePrefs(); S.cache = {}; scheduleAll(); });
    $("opt-colortrace").addEventListener("change", function () { P.colorTrace = this.checked; savePrefs(); scheduleAll(); });
    $("opt-histlog").addEventListener("change", function () { P.histLog = this.checked; savePrefs(); scheduleAll(); });
  }

  /* ── events ───────────────────────────────────────────────────── */

  function onClick(ev) {
    if (!el.menu.hidden && !ev.target.closest(".settings")) { el.menu.hidden = true; el.btnSettings.setAttribute("aria-expanded", "false"); }
    if (!el.cellMenu.hidden && !ev.target.closest(".cell-menu") && !ev.target.closest(".cell__title")) { closeMenus(); }
    var t = ev.target.closest("[data-action]"); if (!t) { return; }
    var a = t.getAttribute("data-action");
    switch (a) {
      case "cell-menu": openCellMenu(t); break;
      case "pick-kind": {
        var i = Number(t.getAttribute("data-cell")), parts = t.getAttribute("data-kind").split(":");
        P.cells[i] = parts[1] ? { k: parts[0], m: parts[1] } : { k: parts[0] };
        savePrefs(); closeMenus(); V[i] = null; updateZoomUI(i); S.cells[i].meta.textContent = ""; scheduleCell(i); break;
      }
      case "mode": closeMenus(); setMode(t.getAttribute("data-mode")); break;
      case "refresh": closeMenus(); window.ScopeCapture.refresh(); toast("Refreshing…", "info"); break;
      case "open-color": closeMenus(); openModal("color"); break;
      case "open-settings": closeMenus(); openModal("display"); break;
      case "modal-close": closeModal(); break;
      case "roi-clear": closeMenus(); clearRoi(); break;
      case "view-reset": resetView(Number(t.getAttribute("data-cell"))); break;
      case "view-reset-all": closeMenus(); toast(resetAllViews() ? "Zoom and position reset" : "Nothing is zoomed", "info"); break;
      case "reset-layout": closeMenus(); P.cells = JSON.parse(JSON.stringify(DEFAULTS.cells)); P.layout = "auto"; savePrefs(); V = []; S.count = 0; scheduleAll(); syncModal(); break;
      case "copy-info": closeMenus(); copyText(frameInfoText(), function (ok) { toast(ok ? "Frame info copied" : "Could not copy", ok ? "success" : "error"); }); break;
      case "copy-hex": copyText(t.getAttribute("data-hex").toUpperCase(), function (ok) { toast(ok ? t.getAttribute("data-hex").toUpperCase() + " copied" : "Could not copy", ok ? "success" : "error"); }); break;
    }
  }

  function toast(m, type) { if (window.showNotification) { window.showNotification(m, type); } }

  function frameInfoText() {
    if (!S.frame) { return "No frame yet."; }
    var st = A.stats(S.frame, { coef: coefName() }, S.roi), c = S.snap && S.snap.comp;
    return [(c ? c.name + "  " + c.w + "x" + c.h + "  frame " + c.frame : "Frame"), S.desc.label,
      "Luma  min " + fv(st.luma.min) + "  mean " + fv(st.luma.mean) + "  max " + fv(st.luma.max),
      "Clip  highlights " + pct(st.clipHi) + "  shadows " + pct(st.clipLo) + (st.over > 0 ? "  over 100% " + pct(st.over) : ""),
      "Average " + st.avgHex.toUpperCase() + (S.roi ? "  (ROI " + S.roi.w + "x" + S.roi.h + ")" : "")].join("\n");
  }

  function typing(ev) { var t = ev.target; return t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA"); }

  function onKey(ev) {
    if (ev.key === "Escape") { if (!el.modal.hidden) { closeModal(); } else { closeMenus(); } return; }
    if (typing(ev) || !el.modal.hidden || ev.ctrlKey || ev.metaKey) { return; }
    // with the cursor over a scope:  + / -  zoom at the cursor,  0  resets,  Space + drag pans
    if (ev.key === " " && hot.i >= 0) {
      spaceDown = true; ev.preventDefault();
      if (S.cells[hot.i]) { S.cells[hot.i].canvas.classList.add("is-hand"); }
      return;
    }
    if (hot.i < 0 || !S.cells[hot.i] || !S.frame) { return; }
    var k = P.cells[hot.i].k;
    if (ev.key === "+" || ev.key === "=") { ev.preventDefault(); zoomCell(hot.i, hot.u, hot.w, 1.5, ev.shiftKey && k === "waveform" ? "x" : "xy"); }
    else if (ev.key === "-" || ev.key === "_") { ev.preventDefault(); zoomCell(hot.i, hot.u, hot.w, 1 / 1.5, "xy"); }
    else if (ev.key === "0" || ev.key === "Home") { ev.preventDefault(); resetView(hot.i); }
  }
  function onKeyUp(ev) {
    if (ev.key === " ") { spaceDown = false; S.cells.forEach(function (c) { c.canvas.classList.remove("is-hand"); }); }
  }

  /* ── boot ─────────────────────────────────────────────────────── */

  function onState(s) {
    if (s.state === "capturing") { setDot("busy"); }
    else if (s.state === "idle") { setDot("ready"); S.lastError = ""; }
    else if (s.state === "nocomp") { setDot("idle"); if (S.frame) { S.frame = null; S.decoded = null; S.desc = null; } S.snap = s.snap; updateChips(); updateInfo(); showEmpty(s.snap); }
    else if (s.state === "error") {
      setDot("error");
      if (s.message && s.message !== S.lastError) { S.lastError = s.message; toast(s.message, "error"); }
      el.compLabel.innerHTML = "<span>" + esc(s.message || "Error") + "</span>";
    }
  }

  function showEmpty(snap) {
    S.empty = {
      title: snap && snap.kind === "footage" ? "Footage viewer is active" : "Open a composition",
      hint: "Scopes follow the active composition and update automatically as you scrub or edit.",
    };
    scheduleAll();
  }

  function onSnapshot(snap) { S.snap = snap; if (snap.kind === "comp") { updateChips(); } }

  function start() {
    el.grid = $("grid"); el.info = $("info"); el.dot = $("status-dot"); el.compLabel = $("comp-label"); el.compChip = $("comp-chip");
    el.roiChip = $("roi-chip"); el.roiLabel = $("roi-label"); el.menu = $("settings-menu"); el.btnSettings = $("btn-settings"); el.cellMenu = $("cell-menu");
    el.modal = $("modal"); el.badge = $("pipeline-badge"); el.badgeText = $("badge-text"); el.badgeHdr = $("badge-hdr"); el.badgeNote = $("badge-note");

    el.btnSettings.addEventListener("click", function (ev) { ev.stopPropagation(); closeMenus(); el.menu.hidden = !el.menu.hidden; el.btnSettings.setAttribute("aria-expanded", String(!el.menu.hidden)); });
    document.addEventListener("click", onClick); document.addEventListener("keydown", onKey); document.addEventListener("keyup", onKeyUp); bindDrag();
    window.addEventListener("resize", scheduleAll);
    bindModal(); setMode(P.mode); buildCells(); updateInfo(); updateChips();

    window.ScopeCapture.start({
      onFrame: onFrame, onState: onState, onSnapshot: onSnapshot,
      isLive: function () { return P.mode === "live"; }, isManual: function () { return P.mode === "manual"; }, getTargetW: function () { return Number(P.quality) || 480; },
    });
  }

  start();
  window.ScopesApp = { state: S, prefs: P, reprocess: reprocess, views: function () { return V; }, setView: setView, resetAllViews: resetAllViews, zoomCell: zoomCell };
})();
