/*
 * Zoom / pan state for one scope.  Pure maths, no DOM.
 *
 * A view is a window onto the scope's natural extent, in fractions 0..1 measured the way the screen is drawn:
 *   x0..x1 left -> right,  y0..y1 TOP -> bottom.        Full view = { x0: 0, x1: 1, y0: 0, y1: 1 }.
 * Every scope maps that window onto its own data (waveform: picture columns x level, vectorscope: Cb x Cr,
 * CIE: x x y, histogram: level) - see analyze.js `win` options and render.js.
 */
(function (root) {
  "use strict";

  var MAX_ZOOM = 32;                       // window is never narrower than 1/32 of the extent
  var EPS = 1e-6;

  function full() { return { x0: 0, x1: 1, y0: 0, y1: 1 }; }
  function copy(v) { return { x0: v.x0, x1: v.x1, y0: v.y0, y1: v.y1 }; }
  function isFull(v) { return !v || (v.x0 <= EPS && v.y0 <= EPS && v.x1 >= 1 - EPS && v.y1 >= 1 - EPS); }
  function zoomX(v) { return 1 / (v.x1 - v.x0); }
  function zoomY(v) { return 1 / (v.y1 - v.y0); }
  function key(v) { return isFull(v) ? "1" : [v.x0, v.x1, v.y0, v.y1].map(function (n) { return n.toFixed(4); }).join(","); }

  // slide a window of the given size so it lies inside 0..1
  function fit(a, size) {
    if (size >= 1) { return [0, 1]; }
    a = Math.max(0, Math.min(1 - size, a));
    return [a, a + size];
  }

  /*
   * Zoom by factors (fx, fy) (>1 zooms in) keeping the point under the cursor fixed.
   * (u, w) = cursor position inside the CURRENT window, 0..1 left->right, 0..1 top->bottom.
   * axes: "xy" | "x" | "y"
   */
  function zoom(v, u, w, fx, fy, axes) {
    axes = axes || "xy";
    var n = copy(v);
    if (axes.indexOf("x") >= 0) {
      var sx = v.x1 - v.x0, nsx = Math.max(1 / MAX_ZOOM, Math.min(1, sx / fx)), px = v.x0 + u * sx;
      var rx = fit(px - u * nsx, nsx); n.x0 = rx[0]; n.x1 = rx[1];
    }
    if (axes.indexOf("y") >= 0) {
      var sy = v.y1 - v.y0, nsy = Math.max(1 / MAX_ZOOM, Math.min(1, sy / fy)), py = v.y0 + w * sy;
      var ry = fit(py - w * nsy, nsy); n.y0 = ry[0]; n.y1 = ry[1];
    }
    return n;
  }

  // drag by (du, dv) expressed in fractions of the CURRENT window (drag right => content follows, so the window moves left)
  function pan(v, du, dv) {
    var sx = v.x1 - v.x0, sy = v.y1 - v.y0, rx = fit(v.x0 - du * sx, sx), ry = fit(v.y0 - dv * sy, sy);
    return { x0: rx[0], x1: rx[1], y0: ry[0], y1: ry[1] };
  }

  // re-centre/clamp after the content changed (keeps the sizes)
  function clamp(v) {
    var rx = fit(v.x0, Math.min(1, v.x1 - v.x0)), ry = fit(v.y0, Math.min(1, v.y1 - v.y0));
    return { x0: rx[0], x1: rx[1], y0: ry[0], y1: ry[1] };
  }

  // zoom around the window's centre by a factor (keyboard +/-)
  function step(v, f, axes) { return zoom(v, 0.5, 0.5, f, f, axes); }

  // "4.0×" / "12×" label; with unequal axes "4×·1.5×"
  function label(v) {
    function f(z) { return z >= 10 ? Math.round(z) + "×" : (Math.round(z * 10) / 10).toFixed(1).replace(/\.0$/, "") + "×"; }
    var zx = zoomX(v), zy = zoomY(v);
    return Math.abs(zx - zy) < 0.05 ? f(zx) : f(zx) + " · " + f(zy);
  }

  var api = { MAX_ZOOM: MAX_ZOOM, full: full, copy: copy, isFull: isFull, zoomX: zoomX, zoomY: zoomY, key: key, zoom: zoom, pan: pan, clamp: clamp, step: step, label: label };
  if (typeof window !== "undefined") { window.ScopeView = api; }
})(typeof window !== "undefined" ? window : this);
