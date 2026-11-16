/*
 * Scopes analysis engine - pure functions, no DOM.
 *
 * Works on FRAMES produced by the colour pipeline (color.js):
 *   { w, h, view: Float32Array(w*h*3)   display-referred, gamma-encoded RGB (1.0 = 100%, may exceed 1 or go < 0)
 *            lin:  Float32Array(w*h*3)  linear light in the working primaries (for CIE xy)
 *            alpha: Uint8Array(w*h)|null, prim: working primaries key }
 * Every analyser accepts an optional ROI {x, y, w, h} in frame pixels, and `coef` = rec601 | rec709 | rec2020.
 */
(function (root) {
  "use strict";

  var Color = root.ScopeColor;

  var COEFFS = {
    rec709: { kr: 0.2126, kg: 0.7152, kb: 0.0722 },
    rec601: { kr: 0.299, kg: 0.587, kb: 0.114 },
    rec2020: { kr: 0.2627, kg: 0.678, kb: 0.0593 },
  };
  function coefOf(name) { return COEFFS[name] || COEFFS.rec709; }

  /* ── colour maths on single colours (0..1 floats) ─────────────── */

  function rgbToHsl(r, g, b) {
    var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2, h = 0, s = 0;
    if (d > 1e-9) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) { h = (g - b) / d + (g < b ? 6 : 0); } else if (max === g) { h = (b - r) / d + 2; } else { h = (r - g) / d + 4; }
      h *= 60;
    }
    return [h, s, l];
  }
  function rgbToHsv(r, g, b) {
    var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, h = 0;
    if (d > 1e-9) {
      if (max === r) { h = (g - b) / d + (g < b ? 6 : 0); } else if (max === g) { h = (b - r) / d + 2; } else { h = (r - g) / d + 4; }
      h *= 60;
    }
    return [h, max <= 0 ? 0 : d / max, max];
  }
  // linear RGB in `prim` primaries -> CIE XYZ
  function linToXYZ(m, r, g, b) { return [m[0] * r + m[1] * g + m[2] * b, m[3] * r + m[4] * g + m[5] * b, m[6] * r + m[7] * g + m[8] * b]; }
  function xyzToLab(X, Y, Z, white) {
    function f(t) { return t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116; }
    var fx = f(X / white[0]), fy = f(Y / white[1]), fz = f(Z / white[2]);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }
  function hex(r, g, b) {
    function h2(v) { var s = Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16); return s.length < 2 ? "0" + s : s; }
    return "#" + h2(r) + h2(g) + h2(b);
  }
  function lumaOf(r, g, b, c) { return c.kr * r + c.kg * g + c.kb * b; }

  // everything the readout needs about one pixel
  function pixelAt(frame, x, y, coefName) {
    x = Math.max(0, Math.min(frame.w - 1, x | 0)); y = Math.max(0, Math.min(frame.h - 1, y | 0));
    var i = (y * frame.w + x) * 3, v = frame.view, c = coefOf(coefName);
    var r = v[i], g = v[i + 1], b = v[i + 2], rc = Math.max(0, Math.min(1, r)), gc = Math.max(0, Math.min(1, g)), bc = Math.max(0, Math.min(1, b));
    var yy = lumaOf(r, g, b, c);
    var hsl = rgbToHsl(rc, gc, bc), hsv = rgbToHsv(rc, gc, bc);
    var info = {
      r: r, g: g, b: b, hex: hex(r, g, b), y: yy,
      h: hsl[0], sHsl: hsl[1], l: hsl[2], sHsv: hsv[1], v: hsv[2],
      cb: (b - yy) / (2 * (1 - c.kb)), cr: (r - yy) / (2 * (1 - c.kr)),
    };
    if (frame.lin) {
      var m = Color.rgbToXyzMatrix(frame.prim || "rec709"), P = Color.PRIM[frame.prim] || Color.PRIM.rec709, W = Color.WHITE[P.white];
      var xyz = linToXYZ(m, frame.lin[i], frame.lin[i + 1], frame.lin[i + 2]);
      var sum = xyz[0] + xyz[1] + xyz[2];
      info.xy = sum > 1e-6 ? [xyz[0] / sum, xyz[1] / sum] : null;
      info.lab = xyzToLab(xyz[0], xyz[1], xyz[2], [W[0] / W[1], 1, (1 - W[0] - W[1]) / W[1]]);
      info.linear = [frame.lin[i], frame.lin[i + 1], frame.lin[i + 2]];
      info.nits = null;
    }
    return info;
  }

  /* ── helpers ──────────────────────────────────────────────────── */

  function roiOf(frame, roi) {
    var x0 = 0, y0 = 0, x1 = frame.w, y1 = frame.h;
    if (roi) {
      x0 = Math.max(0, Math.min(frame.w - 1, Math.floor(roi.x)));
      y0 = Math.max(0, Math.min(frame.h - 1, Math.floor(roi.y)));
      x1 = Math.max(x0 + 1, Math.min(frame.w, Math.ceil(roi.x + roi.w)));
      y1 = Math.max(y0 + 1, Math.min(frame.h, Math.ceil(roi.y + roi.h)));
    }
    return { x0: x0, y0: y0, x1: x1, y1: y1, w: x1 - x0, h: y1 - y0 };
  }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  // zoom window (see view.js): fractions of the scope's natural extent, y measured from the TOP.  Undefined = whole scope.
  function winOf(w) {
    w = w || {};
    var o = { x0: w.x0 || 0, x1: w.x1 === undefined ? 1 : w.x1, y0: w.y0 || 0, y1: w.y1 === undefined ? 1 : w.y1 };
    o.x = o.x0 > 1e-6 || o.x1 < 1 - 1e-6; o.y = o.y0 > 1e-6 || o.y1 < 1 - 1e-6; o.any = o.x || o.y;
    return o;
  }

  // largest value in the frame and how many pixels exceed 100% / sit below 0 (used to pick the scope range)
  function range(frame, roiArg) {
    var r = roiOf(frame, roiArg), v = frame.view, a = frame.alpha, W = frame.w, max = 0, min = 0, over = 0, under = 0, n = 0;
    for (var y = r.y0; y < r.y1; y++) {
      for (var x = r.x0; x < r.x1; x++) {
        var p = y * W + x;
        if (a && a[p] === 0) { continue; }
        n++;
        var m = v[p * 3] > v[p * 3 + 1] ? (v[p * 3] > v[p * 3 + 2] ? v[p * 3] : v[p * 3 + 2]) : (v[p * 3 + 1] > v[p * 3 + 2] ? v[p * 3 + 1] : v[p * 3 + 2]);
        var mn = v[p * 3] < v[p * 3 + 1] ? (v[p * 3] < v[p * 3 + 2] ? v[p * 3] : v[p * 3 + 2]) : (v[p * 3 + 1] < v[p * 3 + 2] ? v[p * 3 + 1] : v[p * 3 + 2]);
        if (m > max) { max = m; } if (mn < min) { min = mn; }
        if (m > 1.0005) { over++; }
        if (mn < -0.0005) { under++; }
      }
    }
    return { max: max, min: min, over: n ? over / n : 0, under: n ? under / n : 0, count: n };
  }

  // pick the vertical scale: 1.0 normally; extend (to 1.25 / 1.5 / 2 / 4 ...) only when meaningful pixels exceed 100%
  function autoRange(rg) {
    if (rg.over < 0.0005 && rg.max < 1.02) { return 1; }
    var steps = [1.25, 1.5, 2, 3, 4, 6, 10];
    for (var i = 0; i < steps.length; i++) { if (rg.max <= steps[i] * 1.001) { return steps[i]; } }
    return 10;
  }

  /* ── waveform ─────────────────────────────────────────────────── */
  // modes: luma | rgb (overlay) | parade (R,G,B side by side) | ycbcr (Y,Cb,Cr side by side)
  function waveform(frame, opts, roiArg) {
    opts = opts || {};
    var mode = opts.mode || "luma", rows = opts.rows || 256, coef = coefOf(opts.coef), rmax = opts.range || 1;
    var r = roiOf(frame, roiArg), v = frame.view, a = frame.alpha, W = frame.w, win = winOf(opts.win);
    // zoomed in: only the picture columns inside the window are plotted, and only levels t0..t1 (t = level / range, 0 at the bottom)
    var t0 = 1 - win.y1, t1 = 1 - win.y0, tSpan = t1 - t0;
    var xs = win.x ? r.x0 + Math.floor(win.x0 * r.w) : r.x0, xe = win.x ? Math.min(r.x1, r.x0 + Math.ceil(win.x1 * r.w)) : r.x1;
    var visW = Math.max(1, xe - xs);
    var cols = Math.max(16, Math.min(opts.cols || 512, visW * 2));
    var layers = [];
    function mk(key, color, x0, x1) {
      var span = Math.max(1, Math.round((x1 - x0) * cols));
      layers.push({ key: key, color: color, x0: x0, x1: x1, span: span, bins: new Float32Array(span * rows) });
    }
    if (mode === "luma") { mk("Y", [235, 235, 235], 0, 1); }
    else if (mode === "rgb") { mk("R", [255, 40, 40], 0, 1); mk("G", [40, 255, 40], 0, 1); mk("B", [60, 90, 255], 0, 1); }
    else if (mode === "parade") { mk("R", [255, 70, 70], 0, 1 / 3); mk("G", [70, 255, 70], 1 / 3, 2 / 3); mk("B", [90, 120, 255], 2 / 3, 1); }
    else { mk("Y", [235, 235, 235], 0, 1 / 3); mk("Cb", [90, 140, 255], 1 / 3, 2 / 3); mk("Cr", [255, 90, 90], 2 / 3, 1); }

    var top = rows - 1, inv = 1 / rmax, ux0 = win.x ? win.x0 : 0, uSpan = win.x ? (win.x1 - win.x0) : 1;
    for (var y = r.y0; y < r.y1; y++) {
      for (var x = xs; x < xe; x++) {
        var p = y * W + x;
        if (a && a[p] === 0) { continue; }
        var R = v[p * 3], G = v[p * 3 + 1], B = v[p * 3 + 2];
        var u = ((x - r.x0) / r.w - ux0) / uSpan, v0, v1, v2;
        if (u < 0 || u >= 1) { continue; }
        if (mode === "luma") { v0 = lumaOf(R, G, B, coef); }
        else if (mode === "rgb" || mode === "parade") { v0 = R; v1 = G; v2 = B; }
        else {
          var yy = lumaOf(R, G, B, coef);
          v0 = yy; v1 = (B - yy) / (2 * (1 - coef.kb)) + 0.5; v2 = (R - yy) / (2 * (1 - coef.kr)) + 0.5;   // chroma centred on mid-scale
        }
        for (var li = 0; li < layers.length; li++) {
          var L = layers[li], val = li === 0 ? v0 : (li === 1 ? v1 : v2);
          var col = Math.min(L.span - 1, Math.floor(u * L.span));            // each panel (or the single trace) spans the whole picture width
          var scaled = (mode === "ycbcr" && li > 0) ? val : val * inv;          // chroma channels are always 0..1
          var row = win.y ? Math.round((scaled - t0) / tSpan * top) : Math.round(scaled * top);
          if (win.y) { if (row < 0 || row > top) { continue; } }                 // zoomed in vertically: levels outside the window are simply off-screen
          else if (row < 0) { row = 0; } else if (row > top) { row = top; }
          L.bins[col * rows + row] += 1;
        }
      }
    }
    var peak = 0;
    for (var q = 0; q < layers.length; q++) { var bb = layers[q].bins; for (var k = 0; k < bb.length; k++) { if (bb[k] > peak) { peak = bb[k]; } } }
    return { mode: mode, cols: cols, rows: rows, layers: layers, peak: peak, srcRows: r.h, range: rmax, t0: t0, t1: t1, x0: win.x0, x1: win.x1, zoomY: 1 / tSpan, zoomX: 1 / uSpan };
  }

  /* ── vectorscope ──────────────────────────────────────────────── */
  function vectorscope(frame, opts, roiArg) {
    opts = opts || {};
    var size = opts.size || 256, zoom = opts.zoom || 1, coef = coefOf(opts.coef);
    var r = roiOf(frame, roiArg), v = frame.view, a = frame.alpha, W = frame.w;
    var counts = new Float32Array(size * size), rgb = new Float32Array(size * size * 3), half = size / 2;
    // the zoom window slices the chroma plane: the natural extent is Cb,Cr in -0.5/zoom .. +0.5/zoom
    var win = winOf(opts.win), E = 1 / zoom;
    var cbL = E * (win.x0 - 0.5), crT = E * (0.5 - win.y0), kx = size / (E * (win.x1 - win.x0)), ky = size / (E * (win.y1 - win.y0));
    for (var y = r.y0; y < r.y1; y++) {
      for (var x = r.x0; x < r.x1; x++) {
        var p = y * W + x;
        if (a && a[p] === 0) { continue; }
        var R = v[p * 3], G = v[p * 3 + 1], B = v[p * 3 + 2];
        var yy = lumaOf(R, G, B, coef);
        var cb = (B - yy) / (2 * (1 - coef.kb)), cr = (R - yy) / (2 * (1 - coef.kr));
        var bx = win.any ? Math.floor((cb - cbL) * kx) : Math.floor(half + cb * zoom * size), by = win.any ? Math.floor((crT - cr) * ky) : Math.floor(half - cr * zoom * size);
        if (bx < 0 || by < 0 || bx >= size || by >= size) { continue; }
        var bi = by * size + bx;
        counts[bi] += 1;
        rgb[bi * 3] += clamp01(R); rgb[bi * 3 + 1] += clamp01(G); rgb[bi * 3 + 2] += clamp01(B);
      }
    }
    var peak = 0;
    for (var k = 0; k < counts.length; k++) { if (counts[k] > peak) { peak = counts[k]; } }
    return { size: size, zoom: zoom, counts: counts, rgb: rgb, peak: peak, win: { x0: win.x0, x1: win.x1, y0: win.y0, y1: win.y1 } };
  }

  function vectorTargets(coefName) {
    var coef = coefOf(coefName);
    var defs = [["R", 1, 0, 0], ["Y", 1, 1, 0], ["G", 0, 1, 0], ["C", 0, 1, 1], ["B", 0, 0, 1], ["M", 1, 0, 1]], out = [];
    function ch(R, G, B) { var yy = lumaOf(R, G, B, coef); return { cb: (B - yy) / (2 * (1 - coef.kb)), cr: (R - yy) / (2 * (1 - coef.kr)) }; }
    for (var i = 0; i < defs.length; i++) {
      var d = defs[i], f = ch(d[1], d[2], d[3]), q = ch(d[1] * 0.75, d[2] * 0.75, d[3] * 0.75);
      out.push({ name: d[0], cb: f.cb, cr: f.cr, cb75: q.cb, cr75: q.cr, rgb: [d[1] * 255, d[2] * 255, d[3] * 255] });
    }
    return { targets: out, skinAngleDeg: 123 };
  }

  /* ── histogram ────────────────────────────────────────────────── */
  function histogram(frame, opts, roiArg) {
    opts = opts || {};
    var coef = coefOf(opts.coef), rmax = opts.range || 1, bins = opts.bins || 256;
    var r = roiOf(frame, roiArg), v = frame.view, a = frame.alpha, W = frame.w;
    var hr = new Float32Array(bins), hg = new Float32Array(bins), hb = new Float32Array(bins), hy = new Float32Array(bins);
    var n = 0, top = bins - 1, overR = 0, overG = 0, overB = 0;
    // zoomed in: the bins cover only levels x0..x1 of the range (fractions), so each bin is finer; the rest is off-screen
    var win = winOf(opts.win), k = top / rmax / (win.x1 - win.x0), off = win.x0 * top / (win.x1 - win.x0);
    for (var y = r.y0; y < r.y1; y++) {
      for (var x = r.x0; x < r.x1; x++) {
        var p = y * W + x;
        if (a && a[p] === 0) { continue; }
        var R = v[p * 3], G = v[p * 3 + 1], B = v[p * 3 + 2];
        var ir = Math.round(R * k - off), ig = Math.round(G * k - off), ib = Math.round(B * k - off), iy = Math.round(lumaOf(R, G, B, coef) * k - off);
        if (win.x) {
          if (ir >= 0 && ir <= top) { hr[ir]++; } if (ig >= 0 && ig <= top) { hg[ig]++; } if (ib >= 0 && ib <= top) { hb[ib]++; } if (iy >= 0 && iy <= top) { hy[iy]++; }
        } else {
          hr[ir < 0 ? 0 : (ir > top ? top : ir)]++; hg[ig < 0 ? 0 : (ig > top ? top : ig)]++; hb[ib < 0 ? 0 : (ib > top ? top : ib)]++;
          hy[iy < 0 ? 0 : (iy > top ? top : iy)]++;
        }
        if (R > rmax) { overR++; } if (G > rmax) { overG++; } if (B > rmax) { overB++; }
        n++;
      }
    }
    var peak = 0;
    if (win.x) { for (var j = 0; j <= top; j++) { peak = Math.max(peak, hr[j], hg[j], hb[j], hy[j]); } }
    else { for (var i = 1; i < top; i++) { peak = Math.max(peak, hr[i], hg[i], hb[i], hy[i]); } }   // the end bins hold clipped pixels - don't let them flatten the plot
    if (peak === 0) { peak = Math.max(hr[0], hr[top], hg[0], hg[top], hb[0], hb[top], 1); }
    return { r: hr, g: hg, b: hb, y: hy, peak: peak, count: n, bins: bins, range: rmax, over: { r: overR, g: overG, b: overB }, x0: win.x0, x1: win.x1 };
  }

  /* ── CIE 1931 xy ──────────────────────────────────────────────── */
  var CIE_BOUNDS = [0, 0.8, 0, 0.9];

  function cie(frame, opts, roiArg) {
    opts = opts || {};
    var size = opts.size || 256, r = roiOf(frame, roiArg), a = frame.alpha, W = frame.w, v = frame.view;
    var lin = frame.lin, m = Color.rgbToXyzMatrix(frame.prim || "rec709");
    var counts = new Float32Array(size * size), rgb = new Float32Array(size * size * 3);
    // zoom window -> the part of the xy diagram that is plotted: [xmin, xmax, ymin, ymax]
    var win = winOf(opts.win), B0 = CIE_BOUNDS, bw = B0[1] - B0[0], bh = B0[3] - B0[2];
    var bnd = [B0[0] + win.x0 * bw, B0[0] + win.x1 * bw, B0[3] - win.y1 * bh, B0[3] - win.y0 * bh];
    var sx = size / (bnd[1] - bnd[0]), sy = size / (bnd[3] - bnd[2]);
    for (var y = r.y0; y < r.y1; y++) {
      for (var x = r.x0; x < r.x1; x++) {
        var p = y * W + x;
        if (a && a[p] === 0) { continue; }
        var R, G, B;
        if (lin) { R = lin[p * 3]; G = lin[p * 3 + 1]; B = lin[p * 3 + 2]; }
        else { R = Color.TF.srgb.eotf(v[p * 3]); G = Color.TF.srgb.eotf(v[p * 3 + 1]); B = Color.TF.srgb.eotf(v[p * 3 + 2]); }
        var X = m[0] * R + m[1] * G + m[2] * B, Y = m[3] * R + m[4] * G + m[5] * B, Z = m[6] * R + m[7] * G + m[8] * B, s = X + Y + Z;
        if (!(s > 0.002)) { continue; }                                          // near-black or negative: no meaningful chromaticity
        var bx = Math.floor((X / s - bnd[0]) * sx), by = win.any ? Math.floor((bnd[3] - Y / s) * sy) : size - 1 - Math.floor((Y / s - bnd[2]) * sy);
        if (bx < 0 || by < 0 || bx >= size || by >= size) { continue; }
        var bi = by * size + bx;
        counts[bi] += 1;
        rgb[bi * 3] += clamp01(v[p * 3]); rgb[bi * 3 + 1] += clamp01(v[p * 3 + 1]); rgb[bi * 3 + 2] += clamp01(v[p * 3 + 2]);
      }
    }
    var peak = 0;
    for (var k = 0; k < counts.length; k++) { if (counts[k] > peak) { peak = counts[k]; } }
    return { size: size, counts: counts, rgb: rgb, peak: peak, bounds: bnd, prim: frame.prim || "rec709" };
  }

  // CIE 1931 2-degree spectral locus, 380-700 nm
  var LOCUS = [
    [380, 0.1741, 0.0050], [390, 0.1738, 0.0049], [400, 0.1733, 0.0048], [410, 0.1726, 0.0048], [420, 0.1714, 0.0051],
    [430, 0.1689, 0.0069], [440, 0.1644, 0.0109], [450, 0.1566, 0.0177], [460, 0.1440, 0.0297], [470, 0.1241, 0.0578],
    [480, 0.0913, 0.1327], [490, 0.0454, 0.2950], [500, 0.0082, 0.5384], [510, 0.0139, 0.7502], [520, 0.0743, 0.8338],
    [530, 0.1547, 0.8059], [540, 0.2296, 0.7543], [550, 0.3016, 0.6923], [560, 0.3731, 0.6245], [570, 0.4441, 0.5547],
    [580, 0.5125, 0.4866], [590, 0.5752, 0.4242], [600, 0.6270, 0.3725], [610, 0.6658, 0.3340], [620, 0.6915, 0.3083],
    [630, 0.7079, 0.2920], [640, 0.7190, 0.2809], [650, 0.7260, 0.2740], [660, 0.7300, 0.2700], [670, 0.7320, 0.2680],
    [680, 0.7334, 0.2666], [690, 0.7344, 0.2656], [700, 0.7347, 0.2653],
  ];

  /* ── statistics (values in 0..1 view units; UI formats them) ──── */
  function stats(frame, opts, roiArg) {
    opts = opts || {};
    var coef = coefOf(opts.coef), r = roiOf(frame, roiArg), v = frame.view, a = frame.alpha, W = frame.w, lin = frame.lin;
    var n = 0, sr = 0, sg = 0, sb = 0, sy = 0, sSat = 0, sChroma = 0, clipHi = 0, clipLo = 0, over = 0, neg = 0;
    var minR = 1e9, minG = 1e9, minB = 1e9, maxR = -1e9, maxG = -1e9, maxB = -1e9, minY = 1e9, maxY = -1e9, maxLin = 0;
    var hy = new Uint32Array(1024);
    for (var y = r.y0; y < r.y1; y++) {
      for (var x = r.x0; x < r.x1; x++) {
        var p = y * W + x;
        if (a && a[p] === 0) { continue; }
        var R = v[p * 3], G = v[p * 3 + 1], B = v[p * 3 + 2];
        n++;
        sr += R; sg += G; sb += B;
        if (R < minR) { minR = R; } if (G < minG) { minG = G; } if (B < minB) { minB = B; }
        if (R > maxR) { maxR = R; } if (G > maxG) { maxG = G; } if (B > maxB) { maxB = B; }
        var yy = lumaOf(R, G, B, coef);
        sy += yy; if (yy < minY) { minY = yy; } if (yy > maxY) { maxY = yy; }
        var hi = Math.round(yy * 1000); hy[hi < 0 ? 0 : (hi > 1023 ? 1023 : hi)]++;
        var mx = R > G ? (R > B ? R : B) : (G > B ? G : B), mn = R < G ? (R < B ? R : B) : (G < B ? G : B);
        if (mx >= 0.996) { clipHi++; }
        if (mx > 1.0005) { over++; }
        if (mx <= 0.004) { clipLo++; }
        if (mn < -0.0005) { neg++; }
        var mxc = mx > 1 ? 1 : mx, mnc = mn < 0 ? 0 : mn;
        sSat += mxc <= 0 ? 0 : (mxc - mnc) / mxc;
        var cb = (B - yy) / (2 * (1 - coef.kb)), cr = (R - yy) / (2 * (1 - coef.kr));
        sChroma += Math.sqrt(cb * cb + cr * cr);
        if (lin) { var ml = lin[p * 3] > lin[p * 3 + 1] ? (lin[p * 3] > lin[p * 3 + 2] ? lin[p * 3] : lin[p * 3 + 2]) : (lin[p * 3 + 1] > lin[p * 3 + 2] ? lin[p * 3 + 1] : lin[p * 3 + 2]); if (ml > maxLin) { maxLin = ml; } }
      }
    }
    if (!n) { return { count: 0 }; }
    function pct(frac) { var t = n * frac, acc = 0; for (var i = 0; i < 1024; i++) { acc += hy[i]; if (acc >= t) { return i / 1000; } } return 1; }
    return {
      count: n, width: r.w, height: r.h,
      r: { min: minR, max: maxR, mean: sr / n }, g: { min: minG, max: maxG, mean: sg / n }, b: { min: minB, max: maxB, mean: sb / n },
      luma: { min: minY, max: maxY, mean: sy / n, median: pct(0.5), p1: pct(0.01), p99: pct(0.99) },
      clipHi: clipHi / n, clipLo: clipLo / n, over: over / n, negative: neg / n,
      saturation: sSat / n, chroma: sChroma / n,
      stopsOver: maxLin > 1 ? Math.log(maxLin) / Math.LN2 : 0,                   // brightest pixel, in stops above 100%
      avgHex: hex(sr / n, sg / n, sb / n),
    };
  }

  /* ── dominant palette (median cut on a 5-bit histogram of the display-referred picture) ── */
  function palette(frame, k, roiArg) {
    k = k || 5;
    var r = roiOf(frame, roiArg), v = frame.view, a = frame.alpha, W = frame.w;
    var hist = new Uint32Array(32768), total = 0;
    for (var y = r.y0; y < r.y1; y++) {
      for (var x = r.x0; x < r.x1; x++) {
        var p = y * W + x;
        if (a && a[p] === 0) { continue; }
        var ri = (clamp01(v[p * 3]) * 31 + 0.5) | 0, gi = (clamp01(v[p * 3 + 1]) * 31 + 0.5) | 0, bi = (clamp01(v[p * 3 + 2]) * 31 + 0.5) | 0;
        hist[(ri << 10) | (gi << 5) | bi]++; total++;
      }
    }
    if (!total) { return []; }
    var items = [];
    for (var i = 0; i < 32768; i++) { if (hist[i]) { items.push({ r: i >> 10, g: (i >> 5) & 31, b: i & 31, n: hist[i] }); } }
    function box(list) {
      var mn = [31, 31, 31], mx = [0, 0, 0], pop = 0;
      for (var q = 0; q < list.length; q++) {
        var it = list[q];
        if (it.r < mn[0]) { mn[0] = it.r; } if (it.g < mn[1]) { mn[1] = it.g; } if (it.b < mn[2]) { mn[2] = it.b; }
        if (it.r > mx[0]) { mx[0] = it.r; } if (it.g > mx[1]) { mx[1] = it.g; } if (it.b > mx[2]) { mx[2] = it.b; }
        pop += it.n;
      }
      return { list: list, mn: mn, mx: mx, pop: pop, range: Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) };
    }
    var boxes = [box(items)];
    while (boxes.length < k) {
      var best = -1, bestScore = -1;
      for (var b = 0; b < boxes.length; b++) { var sc = boxes[b].pop * (boxes[b].range + 1); if (boxes[b].list.length > 1 && sc > bestScore) { bestScore = sc; best = b; } }
      if (best < 0) { break; }
      var bx = boxes[best], axis = 0, ext = bx.mx[0] - bx.mn[0];
      if (bx.mx[1] - bx.mn[1] > ext) { axis = 1; ext = bx.mx[1] - bx.mn[1]; }
      if (bx.mx[2] - bx.mn[2] > ext) { axis = 2; }
      var key = axis === 0 ? "r" : (axis === 1 ? "g" : "b");
      bx.list.sort(function (p1, p2) { return p1[key] - p2[key]; });
      var half = bx.pop / 2, acc = 0, cut = 1;
      for (var m = 0; m < bx.list.length; m++) { acc += bx.list[m].n; if (acc >= half) { cut = Math.max(1, Math.min(bx.list.length - 1, m + 1)); break; } }
      boxes.splice(best, 1, box(bx.list.slice(0, cut)), box(bx.list.slice(cut)));
    }
    var out = [];
    for (var z = 0; z < boxes.length; z++) {
      var sR = 0, sG = 0, sB = 0, pp = 0, L = boxes[z].list;
      for (var t = 0; t < L.length; t++) { sR += L[t].r * L[t].n; sG += L[t].g * L[t].n; sB += L[t].b * L[t].n; pp += L[t].n; }
      var rr = sR / pp / 31, gg = sG / pp / 31, bb = sB / pp / 31;
      out.push({ r: rr, g: gg, b: bb, hex: hex(rr, gg, bb), share: pp / total });
    }
    out.sort(function (p1, p2) { return p2.share - p1.share; });
    return out;
  }

  /* ── picture + overlays (8-bit RGBA for the image view) ───────── */

  // the display-referred picture, clamped for the screen
  function toRGBA(frame) {
    var n = frame.w * frame.h, out = new Uint8ClampedArray(n * 4), v = frame.view, a = frame.alpha;
    for (var i = 0; i < n; i++) {
      out[i * 4] = clamp01(v[i * 3]) * 255 + 0.5; out[i * 4 + 1] = clamp01(v[i * 3 + 1]) * 255 + 0.5; out[i * 4 + 2] = clamp01(v[i * 3 + 2]) * 255 + 0.5;
      out[i * 4 + 3] = a ? a[i] : 255;
    }
    return out;
  }

  var FALSE_BANDS = [
    [0.02, 120, 60, 200, "crushed"], [0.10, 40, 80, 220, "deep shadow"], [0.30, 60, 130, 200, "shadow"], [0.42, 70, 170, 90, "mid grey"],
    [0.50, 150, 150, 150, ""], [0.55, 240, 150, 170, "skin"], [0.70, 190, 190, 190, ""], [0.90, 230, 220, 90, "highlight"],
    [0.97, 240, 150, 40, "hot"], [1.0005, 230, 40, 40, "clipping"], [1e9, 255, 0, 255, "over 100%"],
  ];

  function falseColor(frame, opts) {
    var coef = coefOf((opts || {}).coef), n = frame.w * frame.h, v = frame.view, out = new Uint8ClampedArray(n * 4);
    for (var i = 0; i < n; i++) {
      var y = lumaOf(v[i * 3], v[i * 3 + 1], v[i * 3 + 2], coef), mx = Math.max(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]);
      var band = FALSE_BANDS[FALSE_BANDS.length - 1];
      if (mx > 1.0005) { band = FALSE_BANDS[FALSE_BANDS.length - 1]; }
      else { for (var b = 0; b < FALSE_BANDS.length - 1; b++) { if (y < FALSE_BANDS[b][0]) { band = FALSE_BANDS[b]; break; } } }
      out[i * 4] = band[1]; out[i * 4 + 1] = band[2]; out[i * 4 + 2] = band[3]; out[i * 4 + 3] = 255;
    }
    return out;
  }

  function zebra(frame, opts) {
    opts = opts || {};
    var coef = coefOf(opts.coef), hi = (opts.hi === undefined ? 95 : opts.hi) / 100, lo = (opts.lo === undefined ? 4 : opts.lo) / 100;
    var w = frame.w, h = frame.h, v = frame.view, out = new Uint8ClampedArray(w * h * 4);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var i = y * w + x, yy = lumaOf(v[i * 3], v[i * 3 + 1], v[i * 3 + 2], coef), stripe = ((x + y) >> 2) & 1;
        if (yy >= hi && stripe) { out[i * 4] = 255; out[i * 4 + 1] = 255; out[i * 4 + 2] = 255; out[i * 4 + 3] = 215; }
        else if (yy <= lo && stripe) { out[i * 4] = 70; out[i * 4 + 1] = 140; out[i * 4 + 2] = 255; out[i * 4 + 3] = 200; }
      }
    }
    return out;
  }

  function clipMask(frame) {
    var w = frame.w, h = frame.h, v = frame.view, out = new Uint8ClampedArray(w * h * 4);
    for (var i = 0; i < w * h; i++) {
      var R = v[i * 3], G = v[i * 3 + 1], B = v[i * 3 + 2];
      if (R > 1.0005 || G > 1.0005 || B > 1.0005) { out[i * 4] = 255; out[i * 4 + 1] = 0; out[i * 4 + 2] = 220; out[i * 4 + 3] = 235; }       // beyond 100%
      else if (R >= 0.996 || G >= 0.996 || B >= 0.996) { out[i * 4] = 255; out[i * 4 + 1] = 40; out[i * 4 + 2] = 40; out[i * 4 + 3] = 230; }     // at 100%
      else if (R <= 0.004 && G <= 0.004 && B <= 0.004) { out[i * 4] = 40; out[i * 4 + 1] = 90; out[i * 4 + 2] = 255; out[i * 4 + 3] = 215; }    // crushed
    }
    return out;
  }

  var api = {
    COEFFS: COEFFS, coefOf: coefOf, rgbToHsl: rgbToHsl, rgbToHsv: rgbToHsv, hex: hex, pixelAt: pixelAt,
    range: range, autoRange: autoRange,
    waveform: waveform, vectorscope: vectorscope, vectorTargets: vectorTargets, histogram: histogram, cie: cie,
    stats: stats, palette: palette, toRGBA: toRGBA, falseColor: falseColor, zebra: zebra, clipMask: clipMask,
    LOCUS: LOCUS, CIE_BOUNDS: CIE_BOUNDS, FALSE_BANDS: FALSE_BANDS,
  };
  if (typeof window !== "undefined") { window.ScopeAnalyze = api; }
})(typeof window !== "undefined" ? window : this);
