/*
 * Precision PNG decoder for the Scopes panel.
 *
 * Why not <img>/canvas: browsers decode 16-bit PNGs down to 8 bits, and After Effects stores 32 bpc frames in a
 * 16-bit PNG scaled so that 65535 = 10.0 - an 8-bit decode would leave ~25 usable levels.  This decoder keeps
 * full precision, and box-averages down to the analysis size WHILE unfiltering, so a 4K frame never has to be
 * held in memory as floats.
 *
 * decode(buffer, {targetW, inflate})  ->
 *   { w, h, srcW, srcH, depth, rgb: Float32Array(w*h*3) (0..1 of full scale), alpha: Uint8Array(w*h) }
 * Supports colour types 0,2,4,6 at 8 or 16 bits, non-interlaced (what After Effects writes).
 */
(function (root) {
  "use strict";

  function u32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }

  function getInflate(opts) {
    if (opts && opts.inflate) { return opts.inflate; }
    var req = (typeof root.require === "function") ? root.require : (typeof require === "function" ? require : null);
    if (!req) { throw new Error("PNG decoding needs Node.js (zlib) in the panel."); }
    var zlib = req("zlib");
    return function (u8) { return zlib.inflateSync(u8); };
  }

  function decode(buf, opts) {
    opts = opts || {};
    var b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (b.length < 33 || b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) { throw new Error("Not a PNG file."); }

    var W = 0, H = 0, depth = 0, ctype = 0, interlace = 0, idat = [], idatLen = 0, pos = 8;
    while (pos + 8 <= b.length) {
      var len = u32(b, pos), type = String.fromCharCode(b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]);
      if (type === "IHDR") { W = u32(b, pos + 8); H = u32(b, pos + 12); depth = b[pos + 16]; ctype = b[pos + 17]; interlace = b[pos + 20]; }
      else if (type === "IDAT") { idat.push(b.subarray(pos + 8, pos + 8 + len)); idatLen += len; }
      else if (type === "IEND") { break; }
      pos += 12 + len;
    }
    if (!W || !H) { throw new Error("PNG has no IHDR."); }
    if (interlace) { throw new Error("Interlaced PNG is not supported."); }
    if (depth !== 8 && depth !== 16) { throw new Error("Unsupported PNG bit depth: " + depth); }
    var channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ctype];
    if (!channels) { throw new Error("Unsupported PNG colour type: " + ctype); }

    var joined = new Uint8Array(idatLen), off = 0;
    for (var i = 0; i < idat.length; i++) { joined.set(idat[i], off); off += idat[i].length; }
    var raw = getInflate(opts)(joined);
    if (!(raw instanceof Uint8Array)) { raw = new Uint8Array(raw); }

    var bytes = depth / 8, bpp = channels * bytes, stride = W * bpp;
    var step = Math.max(1, Math.floor(W / (opts.targetW || W)));
    var ow = Math.ceil(W / step), oh = Math.ceil(H / step);
    var rgb = new Float32Array(ow * oh * 3), alpha = new Uint8Array(ow * oh);
    var acc = new Float64Array(ow * 4), cnt = new Uint32Array(ow);
    var full = depth === 16 ? 65535 : 255;

    var prev = new Uint8Array(stride), cur = new Uint8Array(stride);
    var p = 0, outRow = 0;

    for (var y = 0; y < H; y++) {
      var ft = raw[p++];
      var line = raw.subarray(p, p + stride); p += stride;
      // unfilter into cur
      var k;
      if (ft === 0) { cur.set(line); }
      else if (ft === 1) { for (k = 0; k < stride; k++) { cur[k] = (line[k] + (k >= bpp ? cur[k - bpp] : 0)) & 255; } }
      else if (ft === 2) { for (k = 0; k < stride; k++) { cur[k] = (line[k] + prev[k]) & 255; } }
      else if (ft === 3) { for (k = 0; k < stride; k++) { cur[k] = (line[k] + (((k >= bpp ? cur[k - bpp] : 0) + prev[k]) >> 1)) & 255; } }
      else if (ft === 4) {
        for (k = 0; k < stride; k++) {
          var a = k >= bpp ? cur[k - bpp] : 0, up = prev[k], c = k >= bpp ? prev[k - bpp] : 0;
          var pa = Math.abs(up - c), pb = Math.abs(a - c), pc = Math.abs(a + up - 2 * c);
          cur[k] = (line[k] + ((pa <= pb && pa <= pc) ? a : (pb <= pc ? up : c))) & 255;
        }
      } else { throw new Error("Bad PNG filter type " + ft); }

      // accumulate this row into the output row's box
      for (var x = 0; x < W; x++) {
        var ox = (x / step) | 0, o = x * bpp, r, g, bl, al = full;
        if (depth === 8) {
          if (channels >= 3) { r = cur[o]; g = cur[o + 1]; bl = cur[o + 2]; if (channels === 4) { al = cur[o + 3]; } }
          else { r = g = bl = cur[o]; if (channels === 2) { al = cur[o + 1]; } }
        } else {
          if (channels >= 3) { r = (cur[o] << 8) | cur[o + 1]; g = (cur[o + 2] << 8) | cur[o + 3]; bl = (cur[o + 4] << 8) | cur[o + 5]; if (channels === 4) { al = (cur[o + 6] << 8) | cur[o + 7]; } }
          else { r = g = bl = (cur[o] << 8) | cur[o + 1]; if (channels === 2) { al = (cur[o + 2] << 8) | cur[o + 3]; } }
        }
        var ai = ox * 4;
        acc[ai] += r; acc[ai + 1] += g; acc[ai + 2] += bl; acc[ai + 3] += al; cnt[ox]++;
      }

      var lastOfBlock = ((y + 1) % step === 0) || y === H - 1;
      if (lastOfBlock) {
        for (var q = 0; q < ow; q++) {
          var n = cnt[q] || 1, di = (outRow * ow + q), ai2 = q * 4;
          rgb[di * 3] = acc[ai2] / n / full; rgb[di * 3 + 1] = acc[ai2 + 1] / n / full; rgb[di * 3 + 2] = acc[ai2 + 2] / n / full;
          alpha[di] = Math.round(acc[ai2 + 3] / n / full * 255);
          acc[ai2] = acc[ai2 + 1] = acc[ai2 + 2] = acc[ai2 + 3] = 0; cnt[q] = 0;
        }
        outRow++;
      }
      var t = prev; prev = cur; cur = t;
    }
    return { w: ow, h: Math.min(oh, outRow), srcW: W, srcH: H, depth: depth, rgb: rgb, alpha: alpha };
  }

  var api = { decode: decode };
  if (typeof window !== "undefined") { window.ScopePNG = api; }
})(typeof window !== "undefined" ? window : this);
