/*
 * Capture loop: keeps the scopes in step with After Effects with no user action.
 *
 *   ~every 50 ms   ScopesHost.snapshot()  (cheap)  -> comp, time, project.revision, colour settings
 *   when any of those changed  (or live mode, or Refresh)  ->  ScopesHost.capture(file)
 *       wait for the PNG to be complete, decode at full precision, run the colour pipeline, hand the frame over.
 *
 * Speed notes (measured on a real 3840x2160 comp: After Effects needs ~1.7 s just to render and write the frame, so
 * everything below is about not adding to that):
 *   - completeness is decided by the PNG's closing IEND chunk, not by "the size stopped changing" - After Effects writes
 *     big files in bursts, which made the old check read half-written files (failed decodes, stale scopes) and cost 30+ ms
 *   - the next snapshot / capture is sent to After Effects BEFORE this frame is decoded and analysed, so After Effects
 *     renders frame N+1 while the panel is still busy with frame N
 *   - a failed decode is retried straight away instead of waiting for the next change
 * Only one capture is ever in flight; if the project changes while one runs the next starts as soon as it finishes,
 * so the scopes always converge on the latest state and never show a stale mix.
 */
(function (root) {
  "use strict";

  var cs = typeof root.CSInterface !== "undefined" ? new root.CSInterface() : null;
  var req = function (m) { return typeof root.require === "function" ? root.require(m) : null; };

  var POLL_MS = 45;              // gap between snapshot round trips (a new one is only sent after the last one answered)
  var MIN_GAP_MS = 25;           // never capture more often than this
  var IEND = [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82];   // length 0, "IEND", CRC

  var opts = null, timer = null, busy = false, polling = false, force = true, seq = 0, lastKey = "", lastEndAt = 0, lastSnap = null, stopped = true;
  var failures = 0, retries = 0, lastPollMs = 0;

  function evalHost(script, cb) {
    if (!cs || !root.__adobe_cep__) { cb(null, "Not running inside After Effects."); return; }
    cs.evalScript(script, function (raw) {
      if (!raw || raw === "EvalScript error.") { cb(null, "After Effects did not answer."); return; }
      var parsed;
      try { parsed = JSON.parse(raw); } catch (e) { cb(null, "Bad reply from After Effects: " + String(raw).slice(0, 80)); return; }
      try { cb(parsed); }                                                    // a bug in OUR handler must not be reported as AE's fault
      catch (e2) { busy = false; polling = false; emitState("error", { message: "Panel error: " + e2.message + (e2.stack ? " @ " + String(e2.stack).split("\n")[1] : ""), snap: null }); }
    });
  }

  function esc(s) { return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"'); }

  function tmpPath() {
    var os = req("os"), path = req("path");
    return path.join(os.tmpdir(), "ae-scopes-" + process.pid + "-" + (seq++ % 4) + ".png").replace(/\\/g, "/");
  }

  // resolve once the PNG's last 12 bytes are the IEND chunk (a PNG is written front to back, so that proves it is whole)
  function waitForFile(p, timeoutMs, cb) {
    var fs = req("fs"), t0 = Date.now(), fd = -1, tail = Buffer.alloc(12);
    function closeFd() { if (fd >= 0) { try { fs.closeSync(fd); } catch (e) { /* ignore */ } fd = -1; } }
    (function poll() {
      var done = false;
      try {
        var size = fs.statSync(p).size;
        if (size >= 45) {
          if (fd < 0) { fd = fs.openSync(p, "r"); }
          fs.readSync(fd, tail, 0, 12, size - 12);
          done = true;
          for (var i = 0; i < 12; i++) { if (tail[i] !== IEND[i]) { done = false; break; } }
        }
      } catch (e) { closeFd(); }                                              // not there yet / locked for a moment
      if (done) { closeFd(); cb(null); return; }
      if (Date.now() - t0 > timeoutMs) { closeFd(); cb(new Error("Timed out waiting for After Effects to write the frame.")); return; }
      setTimeout(poll, 4);
    })();
  }

  function settingsOf(snap) {
    var p = snap.project || {};
    return { bpc: p.bpc, workingSpace: p.workingSpace, linearize: p.linearize, linearBlending: p.linearBlending, cms: p.cms, ocioConfig: p.ocioConfig, gamma: p.gamma };
  }

  function keyOf(snap) {
    var p = snap.project || {}, c = snap.comp;
    return [snap.kind, c ? c.id : "-", c ? c.frame : "-", snap.revision, p.bpc, p.workingSpace, p.linearize, p.linearBlending, p.cms, p.ocioConfig].join("|");
  }

  function emitState(state, extra) {
    if (opts && opts.onState) { var o = extra || {}; o.state = state; opts.onState(o); }
  }

  function doCapture(snap, key) {
    busy = true;
    var t0 = Date.now(), file = tmpPath(), fs = req("fs");
    emitState("capturing", { snap: snap });
    evalHost('ScopesHost.capture("' + esc(file) + '")', function (res, err) {
      if (err || !res || !res.ok) { return finish(err || (res && res.error) || "Capture failed"); }
      var tCalled = Date.now();
      waitForFile(file, 20000, function (werr) {
        if (werr) { return finish(werr.message); }
        var tRead = Date.now(), buf;
        try { buf = fs.readFileSync(file); } catch (e) { return finish("Could not read the frame: " + e.message); }
        try { fs.unlinkSync(file); } catch (e2) { /* temp file, ignore */ }

        // the file is in memory: free the loop NOW so After Effects can start on the next change while we decode this one
        busy = false; lastEndAt = Date.now(); lastKey = key;
        kickNow();

        var tDec = Date.now(), decoded;
        try { decoded = root.ScopePNG.decode(buf, { targetW: opts.getTargetW ? opts.getTargetW() : 480 }); }
        catch (e3) {                                                         // a frame that will not decode: try once or twice more before reporting it
          if (retries < 2) { retries++; lastKey = ""; force = true; return; }
          retries = 0; failures++; emitState("error", { message: "Could not decode the frame: " + e3.message, snap: snap }); return;
        }
        retries = 0; failures = 0;
        var t1 = Date.now();
        try {
          opts.onFrame({ decoded: decoded, snap: snap, settings: settingsOf(snap), timing: { call: tCalled - t0, capture: tRead - t0, decode: t1 - tDec, poll: lastPollMs, total: t1 - t0 } });
        } catch (e4) { failures++; emitState("error", { message: "Scopes failed: " + e4.message, snap: snap }); return; }
        emitState("idle", { snap: snap });
      });
    });

    function finish(msg) {
      busy = false; lastEndAt = Date.now();
      failures++;
      lastKey = key;                                                          // don't hammer a failing frame; the next change will retry
      emitState("error", { message: msg, snap: snap });
      kick();
    }
  }

  // one snapshot round trip; `done` is always called, whatever happens
  function tick(done) {
    if (stopped || busy || polling) { done(); return; }
    if (root.document && root.document.hidden) { done(); return; }            // docked behind another tab: do nothing
    polling = true;
    var tp = Date.now();
    evalHost("ScopesHost.snapshot()", function (snap, err) {
      polling = false; lastPollMs = Date.now() - tp;
      if (stopped) { done(); return; }
      if (err || !snap || !snap.ok) { emitState("error", { message: err || (snap && snap.error) || "No answer", snap: null }); done(); return; }
      lastSnap = snap;
      if (opts.onSnapshot) { opts.onSnapshot(snap); }
      if (snap.kind !== "comp") { emitState("nocomp", { snap: snap }); lastKey = ""; done(); return; }
      var key = keyOf(snap), changed = key !== lastKey;
      var live = opts.isLive && opts.isLive();
      var manual = opts.isManual && opts.isManual();
      if (busy || !(force || (!manual && (changed || live)))) { done(); return; }
      if (Date.now() - lastEndAt < MIN_GAP_MS) { done(); return; }
      if (failures >= 3 && !force && !changed) { done(); return; }
      force = false;
      doCapture(snap, key);
      done();
    });
  }

  function schedule(ms) {
    if (stopped) { return; }
    if (timer) { clearTimeout(timer); }
    timer = setTimeout(loop, ms);
  }
  function loop() { timer = null; tick(function () { schedule(POLL_MS); }); }
  function kick() { if (!stopped) { schedule(0); } }
  function kickNow() { if (stopped) { return; } if (timer) { clearTimeout(timer); timer = null; } loop(); }   // sends the snapshot request immediately, before the caller goes on to decode

  function start(o) {
    opts = o; stopped = false; force = true; failures = 0; retries = 0;
    kick();
  }
  function stop() { stopped = true; if (timer) { clearTimeout(timer); timer = null; } }
  function refresh() { force = true; failures = 0; retries = 0; kick(); }

  root.ScopeCapture = { start: start, stop: stop, refresh: refresh, last: function () { return lastSnap; }, isBusy: function () { return busy; } };
})(window);
