/*
 * Colour pipeline for the Scopes panel.
 *
 * After Effects' saveFrameToPng writes the project's WORKING-SPACE numbers (no display transform):
 *   8 bpc  -> 8-bit PNG,  value = code / 255
 *   16 bpc -> 16-bit PNG, value = code / 65535
 *   32 bpc -> 16-bit PNG, value = code / 65535 * 10      (so 1.0 = white and up to 10.0 survives)
 * This module turns those numbers into what the scopes need:
 *   lin   linear-light RGB in the working space's primaries   (for CIE xy)
 *   view  display-referred, gamma-encoded RGB                 (for waveform / vectorscope / histogram)
 * for every Adobe colour-management setup (None, any working profile, linearized or not) and OCIO.
 *
 */
(function (root) {
  "use strict";

  /* ── transfer functions (scene/display <-> encoded) ───────────── */

  function sgn(x) { return x < 0 ? -1 : 1; }

  var TF = {
    linear: { oetf: function (l) { return l; }, eotf: function (v) { return v; } },
    srgb: {
      oetf: function (l) { var a = Math.abs(l), r = a <= 0.0031308 ? 12.92 * a : 1.055 * Math.pow(a, 1 / 2.4) - 0.055; return sgn(l) * r; },
      eotf: function (v) { var a = Math.abs(v), r = a <= 0.04045 ? a / 12.92 : Math.pow((a + 0.055) / 1.055, 2.4); return sgn(v) * r; },
    },
    rec709: {      // BT.709 camera OETF and its inverse
      oetf: function (l) { var a = Math.abs(l), r = a < 0.018 ? 4.5 * a : 1.099 * Math.pow(a, 0.45) - 0.099; return sgn(l) * r; },
      eotf: function (v) { var a = Math.abs(v), r = a < 0.081 ? a / 4.5 : Math.pow((a + 0.099) / 1.099, 1 / 0.45); return sgn(v) * r; },
    },
    pq: {          // SMPTE ST 2084, linear normalised so 1.0 = 10,000 nits
      oetf: function (l) {
        var m1 = 0.1593017578125, m2 = 78.84375, c1 = 0.8359375, c2 = 18.8515625, c3 = 18.6875, y = Math.pow(Math.max(l, 0), m1);
        return Math.pow((c1 + c2 * y) / (1 + c3 * y), m2);
      },
      eotf: function (v) {
        var m1 = 0.1593017578125, m2 = 78.84375, c1 = 0.8359375, c2 = 18.8515625, c3 = 18.6875, p = Math.pow(Math.max(v, 0), 1 / m2);
        return Math.pow(Math.max(p - c1, 0) / (c2 - c3 * p), 1 / m1);
      },
    },
    hlg: {         // BT.2100 HLG (scene light)
      oetf: function (l) { var a = 0.17883277, b = 0.28466892, c = 0.55991073; l = Math.max(l, 0); return l <= 1 / 12 ? Math.sqrt(3 * l) : a * Math.log(12 * l - b) + c; },
      eotf: function (v) { var a = 0.17883277, b = 0.28466892, c = 0.55991073; v = Math.max(v, 0); return v <= 0.5 ? v * v / 3 : (Math.exp((v - c) / a) + b) / 12; },
    },
    acescct: {
      oetf: function (x) { return x <= 0.0078125 ? 10.5402377416545 * x + 0.0729055341958355 : (Math.log(Math.max(x, 1e-12)) / Math.LN2 + 9.72) / 17.52; },
      eotf: function (y) { return y <= 0.155251141552511 ? (y - 0.0729055341958355) / 10.5402377416545 : Math.pow(2, y * 17.52 - 9.72); },
    },
  };

  function gammaTF(g) {
    return {
      oetf: function (l) { return sgn(l) * Math.pow(Math.abs(l), 1 / g); },
      eotf: function (v) { return sgn(v) * Math.pow(Math.abs(v), g); },
    };
  }

  function tfFor(spec) {
    if (!spec) { return TF.srgb; }
    if (spec.type === "gamma") { return gammaTF(spec.gamma); }
    return TF[spec.type] || TF.srgb;
  }

  /* ── primaries / white points ─────────────────────────────────── */

  var WHITE = {
    d65: [0.3127, 0.3290],
    d60: [0.32168, 0.33767],
    d50: [0.3457, 0.3585],
    dci: [0.314, 0.351],
  };

  var PRIM = {
    rec709: { name: "Rec.709", p: [[0.64, 0.33], [0.30, 0.60], [0.15, 0.06]], white: "d65" },
    p3: { name: "P3", p: [[0.68, 0.32], [0.265, 0.69], [0.15, 0.06]], white: "d65" },
    p3dci: { name: "DCI-P3", p: [[0.68, 0.32], [0.265, 0.69], [0.15, 0.06]], white: "dci" },
    p3d60: { name: "P3-D60", p: [[0.68, 0.32], [0.265, 0.69], [0.15, 0.06]], white: "d60" },
    rec2020: { name: "Rec.2020", p: [[0.708, 0.292], [0.170, 0.797], [0.131, 0.046]], white: "d65" },
    smptec: { name: "SMPTE C (Rec.601)", p: [[0.630, 0.340], [0.310, 0.595], [0.155, 0.070]], white: "d65" },
    ap1: { name: "ACEScg (AP1)", p: [[0.713, 0.293], [0.165, 0.830], [0.128, 0.044]], white: "d60" },
    ap0: { name: "ACES 2065-1 (AP0)", p: [[0.7347, 0.2653], [0.0, 1.0], [0.0001, -0.0770]], white: "d60" },
    adobe: { name: "Adobe RGB", p: [[0.64, 0.33], [0.21, 0.71], [0.15, 0.06]], white: "d65" },
    prophoto: { name: "ProPhoto RGB", p: [[0.7347, 0.2653], [0.1596, 0.8404], [0.0366, 0.0001]], white: "d50" },
  };

  function inv3(m) {
    var a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5], g = m[6], h = m[7], i = m[8];
    var A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
    return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
  }
  function mul3(a, b) {
    var r = [];
    for (var i = 0; i < 3; i++) { for (var j = 0; j < 3; j++) { r.push(a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]); } }
    return r;
  }
  function mulVec(m, v) { return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]]; }

  function xyToXYZ(xy) { return [xy[0] / xy[1], 1, (1 - xy[0] - xy[1]) / xy[1]]; }

  // linear RGB -> XYZ for a set of primaries + white point
  function rgbToXyzMatrix(primKey) {
    var P = PRIM[primKey] || PRIM.rec709, w = xyToXYZ(WHITE[P.white]);
    var r = xyToXYZ(P.p[0]), g = xyToXYZ(P.p[1]), b = xyToXYZ(P.p[2]);
    var m = [r[0], g[0], b[0], r[1], g[1], b[1], r[2], g[2], b[2]];
    var s = mulVec(inv3(m), w);
    return [r[0] * s[0], g[0] * s[1], b[0] * s[2], r[1] * s[0], g[1] * s[1], b[1] * s[2], r[2] * s[0], g[2] * s[1], b[2] * s[2]];
  }

  // Bradford chromatic adaptation between two white points
  var BFD = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];
  function bradford(srcWhite, dstWhite) {
    var s = mulVec(BFD, xyToXYZ(srcWhite)), d = mulVec(BFD, xyToXYZ(dstWhite));
    var scale = [d[0] / s[0], 0, 0, 0, d[1] / s[1], 0, 0, 0, d[2] / s[2]];
    return mul3(inv3(BFD), mul3(scale, BFD));
  }

  // linear RGB (working primaries) -> linear RGB (display primaries), with white-point adaptation
  function gamutMatrix(fromKey, toKey) {
    var from = PRIM[fromKey] || PRIM.rec709, to = PRIM[toKey] || PRIM.rec709;
    var m = rgbToXyzMatrix(fromKey);
    if (from.white !== to.white) { m = mul3(bradford(WHITE[from.white], WHITE[to.white]), m); }
    return mul3(inv3(rgbToXyzMatrix(toKey)), m);
  }

  /* ── classify an After Effects working-space profile name ─────── */

  function parseGamma(name) {
    var m = /gamma\s*([0-9]+(?:\.[0-9]+)?)/i.exec(name) || /\bg\s*([0-9]\.[0-9])\b/i.exec(name);
    return m ? parseFloat(m[1]) : null;
  }

  function classifyProfile(nameIn) {
    var name = String(nameIn || "");
    var n = name.toLowerCase();
    var out = { name: name, trc: { type: "srgb" }, prim: "rec709", assumed: false, log: false, label: name };
    if (!name || n === "none") { out.none = true; out.label = "None"; return out; }

    var g = parseGamma(name);
    if (/acescg/.test(n)) { out.trc = { type: "linear" }; out.prim = "ap1"; out.label = "ACEScg"; }
    else if (/acescct/.test(n)) { out.trc = { type: "acescct" }; out.prim = "ap1"; out.label = "ACEScct"; }
    else if (/aces.*2065|academy color encoding/.test(n)) { out.trc = { type: "linear" }; out.prim = "ap0"; out.label = "ACES 2065-1"; }
    else if (/srgb/.test(n) && !/p3/.test(n)) { out.trc = { type: "srgb" }; out.prim = "rec709"; out.label = "sRGB"; }
    else if (/p3/.test(n)) {
      out.prim = /dci/.test(n) ? "p3dci" : (/d60/.test(n) ? "p3d60" : "p3");
      if (/pq/.test(n)) { out.trc = { type: "pq" }; }
      else if (/hlg/.test(n)) { out.trc = { type: "hlg" }; }
      else if (g) { out.trc = { type: "gamma", gamma: g }; }
      else { out.trc = { type: "srgb" }; }                         // Display P3 / image P3
    }
    else if (/rec\.?\s?2020|bt\.?\s?2020/.test(n)) {
      out.prim = "rec2020";
      if (/pq/.test(n)) { out.trc = { type: "pq" }; } else if (/hlg/.test(n)) { out.trc = { type: "hlg" }; }
      else if (g) { out.trc = { type: "gamma", gamma: g }; } else { out.trc = { type: "rec709" }; }
    }
    else if (/rec\.?\s?709|hdtv|bt\.?\s?709|bt1886/.test(n)) { out.trc = (g || /1886/.test(n)) ? { type: "gamma", gamma: g || 2.4 } : { type: "rec709" }; out.prim = "rec709"; }
    else if (/adobe rgb/.test(n)) { out.trc = { type: "gamma", gamma: 2.19921875 }; out.prim = "adobe"; }
    else if (/prophoto/.test(n)) { out.trc = { type: "gamma", gamma: 1.8 }; out.prim = "prophoto"; }
    else if (/logc|clog|s-log|slog|v-log|vlog|log3g10|redlog|davinci intermediate|filmlight|\blog\b/.test(n)) {
      out.log = true; out.trc = { type: "srgb" }; out.prim = "rec709"; out.assumed = true;    // camera log: values are shown as-is
    }
    else if (g) { out.trc = { type: "gamma", gamma: g }; out.assumed = true; }
    else { out.assumed = true; }                                    // unknown profile: assume sRGB-like
    return out;
  }

  /* ── the pipeline description ─────────────────────────────────── */
  // settings: what After Effects reports  {bpc, workingSpace, linearize, cms (0 Adobe | 1 OCIO), ocioConfig, linearBlending}
  // user:     overrides  {scale: auto|working|display, display: srgb|g24|p3|rec2020, ocioWorking, ocioView, range}
  function describe(settings, user) {
    settings = settings || {};
    user = user || {};
    var bpc = settings.bpc || 8;
    var d = {
      bpc: bpc,
      pngScale: bpc === 32 ? 10 : 1,                                // PNG full scale in working-space units
      cms: settings.cms === 1 ? "ocio" : "adobe",
      notes: [],
    };

    var work;                                                       // {encoded:bool, trc, prim, label}
    if (d.cms === "ocio") {
      var cfg = String(settings.ocioConfig || "");
      var key = user.ocioWorking || (/aces/i.test(cfg) || !cfg ? "acescg" : "linear709");
      var map = {
        acescg: { prim: "ap1", label: "ACEScg" }, linear709: { prim: "rec709", label: "Linear Rec.709" },
        linear2020: { prim: "rec2020", label: "Linear Rec.2020" }, linearp3: { prim: "p3", label: "Linear P3" },
        aces2065: { prim: "ap0", label: "ACES 2065-1" },
      };
      var w = map[key] || map.acescg;
      work = { encoded: false, trc: { type: "linear" }, prim: w.prim, label: w.label + " (OCIO" + (cfg ? ": " + cfg : "") + ")" };
      d.notes.push("OCIO: the viewer's display/view transform can't be read from scripting - using " + (user.ocioView || "sRGB") + ".");
      d.ocioView = user.ocioView || "srgb";
    } else {
      var prof = classifyProfile(settings.workingSpace);
      if (prof.none) {
        work = { encoded: true, trc: { type: "srgb" }, prim: "rec709", label: "No colour management", none: true };
      } else {
        var linear = !!settings.linearize || prof.trc.type === "linear";
        work = { encoded: !linear, trc: linear ? { type: "linear" } : prof.trc, prim: prof.prim, label: prof.label + (settings.linearize ? " (linearized)" : ""), assumed: prof.assumed, log: prof.log, nativeTrc: prof.trc };
        if (prof.assumed) { d.notes.push("Profile not recognised - assuming sRGB transfer and Rec.709 primaries."); }
        if (prof.log) { d.notes.push("Camera-log working space - values shown as encoded (no log-to-linear)."); }
      }
    }
    d.working = work;

    // when linearized, "encoded" values come from linear light through the profile's own curve
    d.encodeTrc = work.nativeTrc || (work.encoded ? work.trc : { type: "srgb" });

    // Adobe: Lumetri Scopes "represent the appearance of your composition ... transformed into the colour space
    // (601, 709, 2020) set in the scopes panel".  Same model here: display-referred by default.
    var scaleMode = (user.scale === "working") ? "working" : "display";
    d.scaleMode = scaleMode;

    var space = user.space || "rec709";                              // scope colour space: rec601 | rec709 | rec2020
    d.space = space;
    d.coef = space;                                                  // luma coefficients follow the scope space
    d.displayPrim = space === "rec2020" ? "rec2020" : (space === "rec601" ? "smptec" : "rec709");
    var tr = user.transfer || (space === "rec2020" ? "g24" : "srgb");   // how the display encodes light
    d.transfer = tr;
    d.displayTrc = tr === "g24" ? { type: "gamma", gamma: 2.4 } : (tr === "g22" ? { type: "gamma", gamma: 2.2 } : (tr === "rec709" ? { type: "rec709" } : { type: "srgb" }));

    var spaceName = { rec709: "Rec.709", rec601: "Rec.601", rec2020: "Rec.2020" }[space];
    var trName = { srgb: "sRGB", g24: "γ2.4", g22: "γ2.2", rec709: "BT.709 OETF" }[tr];
    var parts = [bpc + " bpc", work.label];
    if (work.encoded && !work.none) { parts.push("gamma-encoded"); }
    if (!work.encoded && !work.none) { parts.push("linear-light"); }
    parts.push(scaleMode === "display" ? "as seen in " + spaceName + " (" + trName + ")" : "raw working values");
    d.label = parts.join(" · ");
    return d;
  }

  /* ── LUT-accelerated per-pixel processing ─────────────────────── */

  var LUT_N = 4096;

  function makeLut(fn) {
    var t = new Float32Array(LUT_N + 1);
    for (var i = 0; i <= LUT_N; i++) { t[i] = fn(i / LUT_N); }
    return t;
  }
  function lutApply(table, fn, x) {                                  // table covers [0,1]; fall back to the function elsewhere
    if (x >= 0 && x <= 1) {
      var f = x * LUT_N, i = f | 0, fr = f - i;
      return i >= LUT_N ? table[LUT_N] : table[i] + (table[i + 1] - table[i]) * fr;
    }
    return fn(x);
  }

  // ACES SDR (approximate): ACEScg -> Rec.709 -> Hill's RRT+ODT fit -> sRGB OETF.  Only an approximation of the OCIO view.
  function acesApprox(r, g, b, toRec709) {
    var m = toRec709;
    var R = m[0] * r + m[1] * g + m[2] * b, G = m[3] * r + m[4] * g + m[5] * b, B = m[6] * r + m[7] * g + m[8] * b;
    var a = [0.59719 * R + 0.35458 * G + 0.04823 * B, 0.07600 * R + 0.90834 * G + 0.01566 * B, 0.02840 * R + 0.13383 * G + 0.83777 * B];
    for (var i = 0; i < 3; i++) { var v = Math.max(a[i], 0); a[i] = (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.4329510) + 0.238081); }
    return [1.60475 * a[0] - 0.53108 * a[1] - 0.07367 * a[2], -0.10208 * a[0] + 1.10813 * a[1] - 0.00605 * a[2], -0.00327 * a[0] - 0.07276 * a[1] + 1.07602 * a[2]];
  }

  // decoded: {w,h,rgb: Float32Array(w*h*3) in PNG full-scale 0..1}  ->  {view, lin} Float32Array(w*h*3)
  function process(decoded, desc) {
    var n = decoded.w * decoded.h, src = decoded.rgb;
    var view = new Float32Array(n * 3), lin = new Float32Array(n * 3);
    var scale = desc.pngScale, work = desc.working;
    var eotfT = tfFor(desc.encodeTrc), eotf = eotfT.eotf, oetfEnc = eotfT.oetf;
    var dispT = tfFor(desc.displayTrc), dOetf = dispT.oetf;
    var eotfLut = makeLut(eotf), dispLut = makeLut(dOetf), encLut = makeLut(oetfEnc);
    var toDisp = gamutMatrix(work.prim, desc.displayPrim), toRec709 = gamutMatrix(work.prim, "rec709");
    var display = desc.scaleMode === "display";
    var ocio = desc.cms === "ocio", ocioView = desc.ocioView;
    var identity = work.prim === desc.displayPrim || work.none;
    var xyzMat = rgbToXyzMatrix(work.prim);                                      // kept for callers needing CIE
    void xyzMat;

    for (var i = 0; i < n; i++) {
      var o = i * 3, r = src[o] * scale, g = src[o + 1] * scale, b = src[o + 2] * scale;
      var lr, lg, lb;
      if (work.encoded) { lr = lutApply(eotfLut, eotf, r); lg = lutApply(eotfLut, eotf, g); lb = lutApply(eotfLut, eotf, b); }
      else { lr = r; lg = g; lb = b; }
      lin[o] = lr; lin[o + 1] = lg; lin[o + 2] = lb;

      if (ocio) {
        var vr, vg, vb;
        if (ocioView === "raw") { vr = lr; vg = lg; vb = lb; }
        else if (ocioView === "aces") { var t = acesApprox(lr, lg, lb, toRec709); vr = lutApply(dispLut, dOetf, t[0]); vg = lutApply(dispLut, dOetf, t[1]); vb = lutApply(dispLut, dOetf, t[2]); }
        else {
          var dr = identity ? lr : toDisp[0] * lr + toDisp[1] * lg + toDisp[2] * lb;
          var dg = identity ? lg : toDisp[3] * lr + toDisp[4] * lg + toDisp[5] * lb;
          var db = identity ? lb : toDisp[6] * lr + toDisp[7] * lg + toDisp[8] * lb;
          vr = lutApply(dispLut, dOetf, dr); vg = lutApply(dispLut, dOetf, dg); vb = lutApply(dispLut, dOetf, db);
        }
        view[o] = vr; view[o + 1] = vg; view[o + 2] = vb;
      } else if (display) {
        var xr = identity ? lr : toDisp[0] * lr + toDisp[1] * lg + toDisp[2] * lb;
        var xg = identity ? lg : toDisp[3] * lr + toDisp[4] * lg + toDisp[5] * lb;
        var xb = identity ? lb : toDisp[6] * lr + toDisp[7] * lg + toDisp[8] * lb;
        view[o] = lutApply(dispLut, dOetf, xr); view[o + 1] = lutApply(dispLut, dOetf, xg); view[o + 2] = lutApply(dispLut, dOetf, xb);
      } else if (work.encoded) {
        view[o] = r; view[o + 1] = g; view[o + 2] = b;                           // shown exactly as stored
      } else {
        // linear working space shown "as working values": encode with the working profile's own curve
        view[o] = lutApply(encLut, oetfEnc, lr); view[o + 1] = lutApply(encLut, oetfEnc, lg); view[o + 2] = lutApply(encLut, oetfEnc, lb);
      }
    }
    return { w: decoded.w, h: decoded.h, view: view, lin: lin, alpha: decoded.alpha || null, prim: work.prim, desc: desc };
  }

  var api = {
    TF: TF, gammaTF: gammaTF, tfFor: tfFor, WHITE: WHITE, PRIM: PRIM,
    rgbToXyzMatrix: rgbToXyzMatrix, gamutMatrix: gamutMatrix, bradford: bradford,
    classifyProfile: classifyProfile, describe: describe, process: process,
  };
  if (typeof window !== "undefined") { window.ScopeColor = api; }
})(typeof window !== "undefined" ? window : this);
