/*
 * Scopes renderer - draws analysis results onto canvases.  No analysis happens here.
 * window.ScopeRender = { fit, waveform, vector, histogram, cie, image, unitLabel }
 *
 * Zoom / pan: every renderer draws whatever window the analysis was computed for (wf.t0.., vs.win, hg.x0.., ci.bounds) and
 * re-labels its graticule for it.  `o.view` (view.js) is only used for the small position rails along the edges.
 */
(function (root) {
  "use strict";

  var A = root.ScopeAnalyze;
  var BG = "#161616";
  var GRID = "rgba(255,255,255,0.10)";
  var GRID_STRONG = "rgba(255,255,255,0.22)";
  var LABEL = "#7a7a7a";
  var FONT = '9px "Adobe Clean", "Segoe UI", Tahoma, sans-serif';
  var ACCENT = "#1473e6";

  /* ── canvas sizing ────────────────────────────────────────────── */

  // match the backing store to the element's CSS size * devicePixelRatio; returns {ctx, w, h} in CSS pixels
  function fit(canvas) {
    var dpr = root.devicePixelRatio || 1, cssW = Math.max(1, canvas.clientWidth), cssH = Math.max(1, canvas.clientHeight);
    var bw = Math.round(cssW * dpr), bh = Math.round(cssH * dpr);
    if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, cssW, cssH);
    return { ctx: ctx, w: cssW, h: cssH, dpr: dpr };
  }

  var scratch = null;
  function scratchCanvas(w, h) {
    if (!scratch) { scratch = document.createElement("canvas"); }
    if (scratch.width !== w || scratch.height !== h) { scratch.width = w; scratch.height = h; }
    return scratch;
  }

  // value in 0..1 view units -> label in the chosen unit; `dec` = decimals for percent / float when zoomed far in
  function unitLabel(v, units, dec) {
    dec = dec || 0;
    if (units === "8bit") { return String(Math.round(v * 255)); }
    if (units === "10bit") { return String(Math.round(v * 1023)); }
    if (units === "float") { return dec > 0 ? v.toFixed(dec + 2) : (Math.round(v * 100) / 100).toString(); }
    return dec > 0 ? (v * 100).toFixed(dec) : String(Math.round(v * 100));
  }

  function setText(ctx, color, align, base) {
    ctx.font = FONT; ctx.fillStyle = color || LABEL; ctx.textAlign = align || "left"; ctx.textBaseline = base || "middle";
  }

  // "nice" grid step for a span of values so that lines are at least `minPx` apart over `lenPx` pixels
  var NICE = [0.001, 0.002, 0.005, 0.01, 0.02, 0.025, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5];
  function niceStep(span, lenPx, minPx) {
    for (var i = 0; i < NICE.length; i++) { if (lenPx * NICE[i] / span >= minPx) { return NICE[i]; } }
    return NICE[NICE.length - 1];
  }
  function decimalsFor(step) { return step >= 0.01 ? 0 : (step >= 0.001 ? 1 : 2); }       // step in view units (0.01 = 1 %)

  // thin position rails along the right / bottom edge while zoomed in, like a scrollbar: where is this window in the whole
  function rails(ctx, x, y, w, h, v) {
    if (!v) { return; }
    var zx = v.x1 - v.x0 < 0.9999, zy = v.y1 - v.y0 < 0.9999;
    if (!zx && !zy) { return; }
    ctx.save();
    if (zx) {
      var tw = w - 10; ctx.fillStyle = "rgba(255,255,255,0.10)"; ctx.fillRect(x + 5, y + h - 4, tw, 2);
      ctx.fillStyle = ACCENT; ctx.fillRect(x + 5 + tw * v.x0, y + h - 4, Math.max(5, tw * (v.x1 - v.x0)), 2);
    }
    if (zy) {
      var th = h - 10; ctx.fillStyle = "rgba(255,255,255,0.10)"; ctx.fillRect(x + w - 4, y + 5, 2, th);
      ctx.fillStyle = ACCENT; ctx.fillRect(x + w - 4, y + 5 + th * v.y0, 2, Math.max(5, th * (v.y1 - v.y0)));
    }
    ctx.restore();
  }

  /* ── waveform ─────────────────────────────────────────────────── */

  function waveform(canvas, wf, o) {
    o = o || {};
    var f = fit(canvas), ctx = f.ctx, W = f.w, H = f.h;
    var ml = 30, mr = 4, mt = 8, mb = 8;
    var pw = Math.max(10, W - ml - mr), ph = Math.max(10, H - mt - mb);
    var rmax = wf ? wf.range : (o.range || 1);
    // the window being shown: levels t0..t1 (fractions of the range, 0 = bottom), picture columns x0..x1
    var t0 = wf ? wf.t0 : 0, t1 = wf ? wf.t1 : 1, x0 = wf ? wf.x0 : 0, x1 = wf ? wf.x1 : 1;
    var zoomed = t1 - t0 < 0.9999 || t1 > 1.0001 || t0 > 0.0001;
    var vmin = t0 * rmax, vmax = t1 * rmax;
    function Y(val) { return mt + ph * (1 - (val - vmin) / (vmax - vmin)); }

    // trace
    if (wf && wf.peak > 0) {
      var cols = wf.cols, rows = wf.rows;
      var cv = scratchCanvas(cols, rows), c2 = cv.getContext("2d"), img = c2.createImageData(cols, rows), d = img.data;
      // zooming in spreads the same samples over more bins, so lift the brightness to match
      var gain = (o.intensity || 1) * 40 / Math.max(8, wf.srcRows) * Math.min(6, Math.sqrt(wf.zoomY || 1));
      var minB = (wf.zoomY || 1) > 1.05 || (wf.zoomX || 1) > 1.05 ? 0.4 : 0;                // zoomed in, single samples must stay visible
      for (var li = 0; li < wf.layers.length; li++) {
        var L = wf.layers[li], xo0 = Math.round(L.x0 * cols), col = L.color;
        for (var cx = 0; cx < L.span; cx++) {
          var xo = xo0 + cx;
          if (xo >= cols) { break; }
          for (var r = 0; r < rows; r++) {
            var n = L.bins[cx * rows + r];
            if (n === 0) { continue; }
            var b = 1 - Math.exp(-n * gain);
            if (b < minB) { b = minB; }
            var di = ((rows - 1 - r) * cols + xo) * 4;
            // additive so overlapping RGB traces mix toward white
            d[di] = Math.min(255, d[di] + col[0] * b); d[di + 1] = Math.min(255, d[di + 1] + col[1] * b); d[di + 2] = Math.min(255, d[di + 2] + col[2] * b);
            d[di + 3] = 255;
          }
        }
      }
      c2.putImageData(img, 0, 0);
      ctx.globalAlpha = 1;
      ctx.drawImage(cv, ml, mt, pw, ph);
    }

    // graticule (drawn over the trace, faintly) + labels
    ctx.lineWidth = 1;
    if (rmax > 1 && vmax > 1) {                                       // tint the beyond-100% band so HDR highlights are obvious
      var y100 = Math.max(mt, Y(1));
      ctx.fillStyle = "rgba(220,60,200,0.06)"; ctx.fillRect(ml, mt, pw, Math.max(0, Math.min(ph, y100 - mt)));
    }
    var span = (vmax - vmin) * 100;                                   // visible span, in percent
    var step = zoomed ? niceStep(span / 100, ph, 15) * 100 : (rmax <= 1.5 ? 10 : (rmax <= 3 ? 25 : 50));
    var dec = zoomed ? decimalsFor(step / 100) : 0;
    var first = Math.ceil(vmin * 100 / step - 1e-9) * step;
    for (var p = first; p <= vmax * 100 + 1e-9; p += step) {
      var y = Math.round(Y(p / 100)) + 0.5, major = zoomed || (Math.round(p) % 50 === 0) || Math.round(p) === 100, is100 = Math.abs(p - 100) < 1e-6;
      ctx.strokeStyle = is100 ? GRID_STRONG : (major ? "rgba(255,255,255,0.16)" : GRID);
      ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(ml + pw, y); ctx.stroke();
      if (major || step >= 25) { setText(ctx, is100 ? "#b0b0b0" : LABEL, "right"); ctx.fillText(unitLabel(p / 100, o.units, dec), ml - 4, y); }
    }
    var panels = wf && (wf.mode === "parade" || wf.mode === "ycbcr") ? 3 : 1;
    if (panels === 3) {
      ctx.strokeStyle = GRID_STRONG;
      for (var k = 1; k < 3; k++) { var xx = Math.round(ml + pw * k / 3) + 0.5; ctx.beginPath(); ctx.moveTo(xx, mt); ctx.lineTo(xx, mt + ph); ctx.stroke(); }
      setText(ctx, "#8c8c8c", "center", "top");
      for (var q = 0; q < wf.layers.length; q++) { ctx.fillText(wf.layers[q].key, ml + pw * (q + 0.5) / 3, mt + 2); }
    }
    // zoomed in horizontally: say which picture columns each panel shows (comp pixels)
    if (wf && o.compW && x1 - x0 < 0.9999) {
      setText(ctx, "#8c8c8c", "left", "bottom");
      var pwid = pw / panels, a0 = Math.round(x0 * o.compW), a1 = Math.round(x1 * o.compW);
      for (var pi = 0; pi < panels; pi++) {
        if (panels === 3 && pwid < 70 && pi === 1) { continue; }
        if (panels === 3 && pwid < 70 && pi === 0) { ctx.textAlign = "left"; ctx.fillText(String(a0), ml + 3, mt + ph - 6); continue; }
        ctx.textAlign = "left"; ctx.fillText(String(a0), ml + pwid * pi + 3, mt + ph - 6);
        ctx.textAlign = "right"; ctx.fillText(String(a1), ml + pwid * (pi + 1) - 3, mt + ph - 6);
      }
    }
    ctx.strokeStyle = "rgba(255,255,255,0.28)"; ctx.strokeRect(ml + 0.5, mt + 0.5, pw - 1, ph - 1);
    rails(ctx, ml, mt, pw, ph, o.view);
    return { ml: ml, mt: mt, pw: pw, ph: ph, range: rmax, t0: t0, t1: t1, x0: x0, x1: x1, panels: panels, plot: { x: ml, y: mt, w: pw, h: ph } };
  }

  /* ── vectorscope ──────────────────────────────────────────────── */

  function vector(canvas, vs, o) {
    o = o || {};
    var f = fit(canvas), ctx = f.ctx, W = f.w, H = f.h, size = Math.max(40, Math.min(W, H) - 14), cx = W / 2, cy = H / 2, ox = cx - size / 2, oy = cy - size / 2;
    var zoom = (vs && vs.zoom) || o.zoom || 1, R = size / 2;
    var win = (vs && vs.win) || { x0: 0, x1: 1, y0: 0, y1: 1 };
    var zoomed = win.x1 - win.x0 < 0.9999 || win.y1 - win.y0 < 0.9999;
    var E = 1 / zoom, k = size / (E * (win.x1 - win.x0));                // pixels per unit of Cb/Cr
    var gx = ox + E * (0.5 - win.x0) * k, gy = oy + E * (0.5 - win.y0) * k;   // where Cb = Cr = 0 lands (the centre when not zoomed)

    function clipPlot() {
      ctx.beginPath();
      if (zoomed) { ctx.rect(ox, oy, size, size); } else { ctx.arc(cx, cy, R, 0, Math.PI * 2); }
      ctx.clip();
    }

    if (vs && vs.peak > 0) {
      var n = vs.size, cell = size / n, dot = Math.max(1.8, cell * 1.9), intensity = o.intensity || 1;
      ctx.save(); clipPlot();
      for (var by = 0; by < n; by++) {
        for (var bx = 0; bx < n; bx++) {
          var i = by * n + bx, c = vs.counts[i];
          if (c === 0) { continue; }
          var b = Math.min(1, Math.max(0.3, Math.pow(c / vs.peak, 0.35)) * intensity);
          var rr = vs.rgb[i * 3] / c, gg = vs.rgb[i * 3 + 1] / c, bb = vs.rgb[i * 3 + 2] / c;
          if (o.colorTrace === false) { rr = gg = bb = 1; }
          else { var m = Math.max(rr, gg, bb, 0.001); rr = 0.4 + 0.6 * rr / m; gg = 0.4 + 0.6 * gg / m; bb = 0.4 + 0.6 * bb / m; }
          ctx.fillStyle = "rgba(" + Math.round(rr * 255) + "," + Math.round(gg * 255) + "," + Math.round(bb * 255) + "," + b.toFixed(2) + ")";
          ctx.fillRect(ox + (bx + 0.5) * cell - dot / 2, oy + (by + 0.5) * cell - dot / 2, dot, dot);
        }
      }
      ctx.restore();
    }

    // graticule (clipped to the plot while zoomed so rings and targets can run off the edge)
    var t = A.vectorTargets(o.coef || "rec709");
    ctx.save();
    if (zoomed) { ctx.beginPath(); ctx.rect(ox, oy, size, size); ctx.clip(); }
    ctx.lineWidth = 1;
    [0.25, 0.5, 0.75, 1].forEach(function (r) {
      ctx.beginPath(); ctx.arc(gx, gy, zoomed ? r * 0.5 * k : Math.min(R, r * 0.5 * k), 0, Math.PI * 2); ctx.strokeStyle = r === 1 ? GRID_STRONG : GRID; ctx.stroke();
    });
    ctx.strokeStyle = GRID;
    ctx.beginPath(); ctx.moveTo(ox, Math.round(gy) + 0.5); ctx.lineTo(ox + size, Math.round(gy) + 0.5); ctx.moveTo(Math.round(gx) + 0.5, oy); ctx.lineTo(Math.round(gx) + 0.5, oy + size); ctx.stroke();
    // skin tone line
    var a = t.skinAngleDeg * Math.PI / 180, skinLen = zoomed ? size * 4 : R;
    ctx.strokeStyle = "rgba(255,196,150,0.55)"; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(gx, gy); ctx.lineTo(gx + Math.cos(a) * skinLen, gy - Math.sin(a) * skinLen); ctx.stroke(); ctx.setLineDash([]);
    // colour targets: 75% boxes, 100% ticks
    setText(ctx, "#b0b0b0", "center");
    var box = 10;
    for (var i2 = 0; i2 < t.targets.length; i2++) {
      var tg = t.targets[i2], x75 = gx + tg.cb75 * k, y75 = gy - tg.cr75 * k, x100 = gx + tg.cb * k, y100 = gy - tg.cr * k;
      var col = "rgb(" + tg.rgb[0] + "," + tg.rgb[1] + "," + tg.rgb[2] + ")";
      ctx.strokeStyle = col; ctx.lineWidth = 1.25; ctx.strokeRect(x75 - box / 2, y75 - box / 2, box, box);
      ctx.beginPath(); ctx.arc(x100, y100, 2, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
      ctx.fillStyle = "#c8c8c8"; ctx.fillText(tg.name, x75 + (x75 >= gx ? box + 1 : -box - 1), y75 + (y75 < gy ? -2 : 2));
    }
    ctx.restore();
    if (zoomed) { ctx.strokeStyle = "rgba(255,255,255,0.28)"; ctx.strokeRect(ox + 0.5, oy + 0.5, size - 1, size - 1); }
    rails(ctx, ox, oy, size, size, o.view);
    return { cx: gx, cy: gy, R: R, scale: k, ox: ox, oy: oy, size: size, zoomed: zoomed, plot: { x: ox, y: oy, w: size, h: size } };
  }

  /* ── histogram ────────────────────────────────────────────────── */

  function histogram(canvas, hg, o) {
    o = o || {};
    var f = fit(canvas), ctx = f.ctx, W = f.w, H = f.h, ml = 6, mr = 6, mt = 8, mb = 16, pw = W - ml - mr, ph = H - mt - mb;
    var rmax = hg ? hg.range : 1, x0 = hg ? hg.x0 || 0 : 0, x1 = hg ? (hg.x1 === undefined ? 1 : hg.x1) : 1, zoomed = x1 - x0 < 0.9999;
    var gain = Math.max(1, o.gain || 1);
    ctx.lineWidth = 1;
    function X(v) { return ml + pw * ((v / rmax) - x0) / (x1 - x0); }        // view units -> px
    if (!zoomed) {
      // graticule: quarters of the 0-100% span, 100% marker when the range is extended
      for (var q = 0; q <= 4; q++) {
        var x = Math.round(ml + pw * (q / 4) / rmax) + 0.5;
        ctx.strokeStyle = GRID; ctx.beginPath(); ctx.moveTo(x, mt); ctx.lineTo(x, mt + ph); ctx.stroke();
        setText(ctx, LABEL, q === 0 ? "left" : (q === 4 && rmax === 1 ? "right" : "center"), "top"); ctx.fillText(unitLabel(q / 4, o.units), x, mt + ph + 3);
      }
    } else {
      var vmin = x0 * rmax, vmax = x1 * rmax, step = niceStep(vmax - vmin, pw, 34), dec = decimalsFor(step);
      for (var v = Math.ceil(vmin / step - 1e-9) * step; v <= vmax + 1e-9; v += step) {
        var gx = Math.round(X(v)) + 0.5;
        ctx.strokeStyle = Math.abs(v - 1) < 1e-6 ? GRID_STRONG : GRID; ctx.beginPath(); ctx.moveTo(gx, mt); ctx.lineTo(gx, mt + ph); ctx.stroke();
        setText(ctx, LABEL, "center", "top"); ctx.fillText(unitLabel(v, o.units, dec), gx, mt + ph + 3);
      }
    }
    if (rmax > 1) { var xb = Math.max(ml, Math.min(ml + pw, X(1))); ctx.fillStyle = "rgba(220,60,200,0.06)"; ctx.fillRect(xb, mt, ml + pw - xb, ph); }
    if (hg && hg.count) {
      var bins = hg.bins, peak = hg.peak, lg = o.log, ln = Math.log(1 + peak);
      function height(v) { return Math.min(1, (lg ? Math.log(1 + v) / ln : v / peak) * gain); }
      var series = [["r", "rgba(255,50,50,0.62)"], ["g", "rgba(50,255,60,0.62)"], ["b", "rgba(70,110,255,0.7)"]];
      ctx.save(); ctx.beginPath(); ctx.rect(ml, mt, pw, ph); ctx.clip();
      ctx.globalCompositeOperation = "lighter";
      for (var s = 0; s < series.length; s++) {
        var arr = hg[series[s][0]];
        ctx.fillStyle = series[s][1];
        ctx.beginPath(); ctx.moveTo(ml, mt + ph);
        for (var i = 0; i < bins; i++) { var px = ml + (i / (bins - 1)) * pw, hh = height(arr[i]) * ph; ctx.lineTo(px, mt + ph - hh); }
        ctx.lineTo(ml + pw, mt + ph); ctx.closePath(); ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = "rgba(235,235,235,0.75)"; ctx.lineWidth = 1; ctx.beginPath();
      for (var j = 0; j < bins; j++) { var lx = ml + (j / (bins - 1)) * pw, ly = mt + ph - height(hg.y[j]) * ph; if (j === 0) { ctx.moveTo(lx, ly); } else { ctx.lineTo(lx, ly); } }
      ctx.stroke();
      ctx.restore();
      if (!zoomed) {
        // clip markers: red tick at an end when more than 0.1% of pixels pile into the last bin
        var t = hg.count * 0.001;
        if (hg.r[bins - 1] + hg.g[bins - 1] + hg.b[bins - 1] > t * 3) { ctx.fillStyle = "#e0453c"; ctx.fillRect(ml + pw - 3, mt, 3, 6); }
        if (hg.r[0] + hg.g[0] + hg.b[0] > t * 3) { ctx.fillStyle = "#3c7be0"; ctx.fillRect(ml, mt, 3, 6); }
      }
      var over = hg.over.r + hg.over.g + hg.over.b;
      if (over > 0) { setText(ctx, "#e060d0", "right", "top"); ctx.fillText("▲ " + (100 * Math.max(hg.over.r, hg.over.g, hg.over.b) / hg.count).toFixed(1) + "% over", ml + pw, mt + 2); }
    }
    ctx.strokeStyle = "rgba(255,255,255,0.28)"; ctx.strokeRect(ml + 0.5, mt + 0.5, pw - 1, ph - 1);
    rails(ctx, ml, mt, pw, ph, o.view);
    return { ml: ml, mt: mt, pw: pw, ph: ph, x0: x0, x1: x1, plot: { x: ml, y: mt, w: pw, h: ph } };
  }

  /* ── CIE 1931 xy ──────────────────────────────────────────────── */

  var GAMUT_STYLE = {
    rec709: ["Rec.709", "rgba(255,255,255,0.55)"], p3: ["P3", "rgba(255,196,110,0.5)"], rec2020: ["Rec.2020", "rgba(120,200,255,0.5)"],
  };

  function cie(canvas, ci, o) {
    o = o || {};
    var C = root.ScopeColor, f = fit(canvas), ctx = f.ctx, W = f.w, H = f.h;
    var b = (ci && ci.bounds) || A.CIE_BOUNDS, full = A.CIE_BOUNDS, zoomed = (b[1] - b[0]) < (full[1] - full[0]) - 1e-9 || (b[3] - b[2]) < (full[3] - full[2]) - 1e-9;
    var ml = 24, mr = 6, mt = 6, mb = 16, pw = W - ml - mr, ph = H - mt - mb;
    // keep the diagram's aspect
    var aspect = (b[1] - b[0]) / (b[3] - b[2]), w = Math.min(pw, ph * aspect), h = w / aspect, ox = ml + (pw - w) / 2, oy = mt + (ph - h) / 2;
    function X(x) { return ox + (x - b[0]) / (b[1] - b[0]) * w; }
    function Y(y) { return oy + h - (y - b[2]) / (b[3] - b[2]) * h; }

    // axes: 0.2 steps normally, finer as you zoom in
    ctx.lineWidth = 1;
    var sx = niceStep(b[1] - b[0], w, 40), sy = niceStep(b[3] - b[2], h, 28), dx = sx < 0.01 ? 3 : (sx < 0.1 ? 2 : 1), dyy = sy < 0.01 ? 3 : (sy < 0.1 ? 2 : 1);
    if (!zoomed) { sx = sy = 0.2; dx = dyy = 1; }
    setText(ctx, LABEL, "center", "top");
    for (var gxv = Math.ceil(b[0] / sx - 1e-9) * sx; gxv <= b[1] + 1e-9; gxv += sx) { var gx = Math.round(X(gxv)) + 0.5; ctx.strokeStyle = GRID; ctx.beginPath(); ctx.moveTo(gx, oy); ctx.lineTo(gx, oy + h); ctx.stroke(); ctx.fillText(gxv.toFixed(dx), gx, oy + h + 3); }
    setText(ctx, LABEL, "right", "middle");
    for (var gyv = Math.ceil(b[2] / sy - 1e-9) * sy; gyv <= b[3] + 1e-9; gyv += sy) { var gy = Math.round(Y(gyv)) + 0.5; ctx.strokeStyle = GRID; ctx.beginPath(); ctx.moveTo(ox, gy); ctx.lineTo(ox + w, gy); ctx.stroke(); ctx.fillText(gyv.toFixed(dyy), ox - 3, gy); }

    ctx.save(); ctx.beginPath(); ctx.rect(ox, oy, w, h); ctx.clip();
    // spectral locus
    var L = A.LOCUS;
    ctx.beginPath(); ctx.moveTo(X(L[0][1]), Y(L[0][2]));
    for (var k = 1; k < L.length; k++) { ctx.lineTo(X(L[k][1]), Y(L[k][2])); }
    ctx.closePath(); ctx.fillStyle = "#1d1d1d"; ctx.fill(); ctx.strokeStyle = "rgba(255,255,255,0.45)"; ctx.stroke();
    setText(ctx, "#6c6c6c", "left", "middle");
    [[450, -1], [500, -1], [520, -1], [550, 1], [600, 1], [650, 1]].forEach(function (p) {
      var row = L.filter(function (r) { return r[0] === p[0]; })[0];
      if (row) { ctx.textAlign = p[1] < 0 ? "right" : "left"; ctx.fillText(String(p[0]), X(row[1]) + p[1] * 5, Y(row[2])); }
    });

    // points (drawn before the gamut outlines so the outlines stay readable)
    if (ci && ci.peak > 0) {
      var n = ci.size, cw = w / n, ch = h / n, dot = Math.max(1.8, Math.max(cw, ch) * 1.9);
      for (var q = 0; q < n * n; q++) {
        var c = ci.counts[q];
        if (c === 0) { continue; }
        var bb = Math.min(1, Math.max(0.4, Math.pow(c / ci.peak, 0.3)));
        var rr = ci.rgb[q * 3] / c, gg = ci.rgb[q * 3 + 1] / c, b2 = ci.rgb[q * 3 + 2] / c, m = Math.max(rr, gg, b2, 0.001);
        ctx.fillStyle = "rgba(" + Math.round((0.35 + 0.65 * rr / m) * 255) + "," + Math.round((0.35 + 0.65 * gg / m) * 255) + "," + Math.round((0.35 + 0.65 * b2 / m) * 255) + "," + bb.toFixed(2) + ")";
        ctx.fillRect(ox + ((q % n) + 0.5) * cw - dot / 2, oy + (Math.floor(q / n) + 0.5) * ch - dot / 2, dot, dot);
      }
    }

    // gamut triangles: the project's working primaries are drawn solid, the usual references dashed
    var work = ci ? ci.prim : "rec709";
    function tri(prim, style, dashed, label) {
      var P = C.PRIM[prim]; if (!P) { return; }
      ctx.beginPath();
      for (var m = 0; m < 3; m++) { var px = X(P.p[m][0]), py = Y(P.p[m][1]); if (m === 0) { ctx.moveTo(px, py); } else { ctx.lineTo(px, py); } }
      ctx.closePath(); ctx.strokeStyle = style; ctx.lineWidth = dashed ? 1 : 1.5; ctx.setLineDash(dashed ? [3, 3] : []); ctx.stroke(); ctx.setLineDash([]);
      if (label) { setText(ctx, style, "left", "middle"); ctx.fillText(label, X(P.p[1][0]) + 4, Y(P.p[1][1])); }
    }
    ["rec709", "p3", "rec2020"].forEach(function (g) { if (g !== work) { tri(g, GAMUT_STYLE[g][1], true, GAMUT_STYLE[g][0]); } });
    var wp = C.PRIM[work];
    tri(work, "rgba(255,255,255,0.9)", false, wp ? wp.name.split(" ")[0] : "");
    // white point
    var w65 = C.WHITE[wp ? wp.white : "d65"];
    ctx.beginPath(); ctx.arc(X(w65[0]), Y(w65[1]), 2.5, 0, Math.PI * 2); ctx.strokeStyle = "#fff"; ctx.lineWidth = 1; ctx.stroke();
    ctx.restore();
    if (zoomed) { ctx.strokeStyle = "rgba(255,255,255,0.28)"; ctx.strokeRect(ox + 0.5, oy + 0.5, w - 1, h - 1); }
    rails(ctx, ox, oy, w, h, o.view);
    return { ox: ox, oy: oy, w: w, h: h, bounds: b, plot: { x: ox, y: oy, w: w, h: h } };
  }

  /* ── image view ───────────────────────────────────────────────── */

  var pic = null, picKey = "";
  // frame: analysis frame; overlay: RGBA overlay (Uint8ClampedArray) or null; roi: {x,y,w,h}|null; hover: {x,y}|null
  // o.view: zoom window (fractions of the picture); o.key: identifies frame+overlay so the picture is only rebuilt when it changed
  function image(canvas, frame, overlay, roi, hover, o) {
    o = o || {};
    var f = fit(canvas), ctx = f.ctx, W = f.w, H = f.h;
    if (!frame) { return null; }
    var v = o.view || { x0: 0, x1: 1, y0: 0, y1: 1 };
    var pad = 4, aw = W - pad * 2, ah = H - pad * 2, s0 = Math.min(aw / frame.w, ah / frame.h), vw = frame.w * s0, vh = frame.h * s0, vx = (W - vw) / 2, vy = (H - vh) / 2;   // the viewport = the fitted picture rectangle
    var zoomed = v.x1 - v.x0 < 0.9999 || v.y1 - v.y0 < 0.9999;
    var s = s0 / (v.x1 - v.x0), dx = vx - v.x0 * frame.w * s, dy = vy - v.y0 * frame.h * s;                                              // picture pixel (fx,fy) lands at (dx + fx*s, dy + fy*s)

    if (!pic) { pic = document.createElement("canvas"); }
    if (!o.key || o.key !== picKey || pic.width !== frame.w || pic.height !== frame.h) {
      pic.width = frame.w; pic.height = frame.h;
      var pc = pic.getContext("2d"), img = pc.createImageData(frame.w, frame.h);
      img.data.set(overlay ? overlay.base : A.toRGBA(frame));
      pc.putImageData(img, 0, 0);
      if (overlay && overlay.layer) {
        var oc = document.createElement("canvas"); oc.width = frame.w; oc.height = frame.h;
        var oi = oc.getContext("2d").createImageData(frame.w, frame.h); oi.data.set(overlay.layer); oc.getContext("2d").putImageData(oi, 0, 0);
        pc.drawImage(oc, 0, 0);
      }
      picKey = o.key || "";
    }
    ctx.save();
    ctx.beginPath(); ctx.rect(vx, vy, vw, vh); ctx.clip();
    ctx.fillStyle = "#2a2a2a"; ctx.fillRect(vx, vy, vw, vh);
    ctx.imageSmoothingEnabled = s < 3;                                       // up close, show the real pixels
    ctx.imageSmoothingQuality = "medium";
    ctx.drawImage(pic, v.x0 * frame.w, v.y0 * frame.h, (v.x1 - v.x0) * frame.w, (v.y1 - v.y0) * frame.h, vx, vy, vw, vh);
    if (s >= 8) {                                                            // pixel grid
      ctx.strokeStyle = "rgba(255,255,255,0.10)"; ctx.lineWidth = 1; ctx.beginPath();
      for (var gx = Math.ceil(v.x0 * frame.w); gx <= v.x1 * frame.w; gx++) { var xx = Math.round(dx + gx * s) + 0.5; ctx.moveTo(xx, vy); ctx.lineTo(xx, vy + vh); }
      for (var gy = Math.ceil(v.y0 * frame.h); gy <= v.y1 * frame.h; gy++) { var yy = Math.round(dy + gy * s) + 0.5; ctx.moveTo(vx, yy); ctx.lineTo(vx + vw, yy); }
      ctx.stroke();
    }
    if (roi) {
      ctx.strokeStyle = ACCENT; ctx.lineWidth = 1.5; ctx.setLineDash([5, 3]);
      ctx.strokeRect(dx + roi.x * s, dy + roi.y * s, roi.w * s, roi.h * s); ctx.setLineDash([]);
      ctx.fillStyle = "rgba(20,115,230,0.10)"; ctx.fillRect(dx + roi.x * s, dy + roi.y * s, roi.w * s, roi.h * s);
    }
    if (hover) {
      var hx = dx + (hover.x + 0.5) * s, hy = dy + (hover.y + 0.5) * s;
      if (s >= 6) {                                                          // zoomed far in: outline the pixel itself
        ctx.strokeStyle = "rgba(0,0,0,0.7)"; ctx.lineWidth = 3; ctx.strokeRect(dx + hover.x * s, dy + hover.y * s, s, s);
        ctx.strokeStyle = "rgba(255,255,255,0.95)"; ctx.lineWidth = 1; ctx.strokeRect(dx + hover.x * s, dy + hover.y * s, s, s);
      } else {
        ctx.strokeStyle = "rgba(255,255,255,0.9)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(hx, hy, 6, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = "rgba(0,0,0,0.6)"; ctx.beginPath(); ctx.arc(hx, hy, 7, 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.restore();
    if (zoomed) { ctx.strokeStyle = "rgba(255,255,255,0.28)"; ctx.lineWidth = 1; ctx.strokeRect(vx + 0.5, vy + 0.5, vw - 1, vh - 1); }
    rails(ctx, vx, vy, vw, vh, o.view);
    return { dx: dx, dy: dy, dw: frame.w * s, dh: frame.h * s, scale: s, vx: vx, vy: vy, vw: vw, vh: vh, plot: { x: vx, y: vy, w: vw, h: vh } };
  }

  root.ScopeRender = { fit: fit, waveform: waveform, vector: vector, histogram: histogram, cie: cie, image: image, unitLabel: unitLabel };
})(window);
