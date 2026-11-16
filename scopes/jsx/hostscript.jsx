/*
    Scopes - host script (loaded into After Effects' main engine by CEP).
    Two cheap calls the panel makes:
        ScopesHost.snapshot()     what is on screen right now + the project's colour settings  (polled)
        ScopesHost.capture(path)  ask After Effects to write the current frame as a PNG          (async on AE's side)
    Both return JSON text.

    Facts this relies on (verified against After Effects 26.3 and the scripting guide):
      - Project.revision is a read-only counter that goes up with every user action.
      - CompItem.saveFrameToPng(time, file) writes the project's WORKING-SPACE numbers: 8-bit PNG at 8 bpc,
        16-bit PNG at 16 and 32 bpc (32 bpc is stored as value/10, so 65535 means 10.0).
*/
(function () {
    function esc(s) {
        return '"' + String(s).replace(/[\\"\u0000-\u001f\u007f-￿]/g, function (c) {
            switch (c) {
                case "\\": return "\\\\";
                case '"': return '\\"';
                case "\n": return "\\n";
                case "\r": return "\\r";
                case "\t": return "\\t";
            }
            var h = c.charCodeAt(0).toString(16);
            while (h.length < 4) { h = "0" + h; }
            return "\\u" + h;
        }) + '"';
    }
    function num(v) { return isFinite(v) ? String(v) : "null"; }
    function val(v) {
        if (v === null || v === undefined) { return "null"; }
        if (typeof v === "number") { return num(v); }
        if (typeof v === "boolean") { return v ? "true" : "false"; }
        if (v instanceof Array) { var a = []; for (var i = 0; i < v.length; i++) { a.push(val(v[i])); } return "[" + a.join(",") + "]"; }
        if (typeof v === "object") { var p = []; for (var k in v) { if (v.hasOwnProperty(k)) { p.push(esc(k) + ":" + val(v[k])); } } return "{" + p.join(",") + "}"; }
        return esc(v);
    }
    function fail(msg) { return '{"ok":false,"error":' + esc(msg) + "}"; }
    function tryGet(fn, fallback) { try { var v = fn(); return v === undefined ? fallback : v; } catch (e) { return fallback; } }

    function snapshot() {
        try {
            var p = app.project;
            var out = {
                ok: true,
                revision: tryGet(function () { return p.revision; }, 0),
                project: {
                    file: tryGet(function () { return p.file ? p.file.fsName : null; }, null),
                    bpc: tryGet(function () { return p.bitsPerChannel; }, 8),
                    workingSpace: tryGet(function () { return p.workingSpace; }, "None"),
                    linearize: tryGet(function () { return p.linearizeWorkingSpace; }, false),
                    linearBlending: tryGet(function () { return p.linearBlending; }, false),
                    cms: tryGet(function () { return p.colorManagementSystem; }, 0),
                    ocioConfig: tryGet(function () { return p.ocioConfigurationFile; }, ""),
                    gamma: tryGet(function () { return p.workingGamma; }, 2.2),
                    compensate: tryGet(function () { return p.compensateForSceneReferredProfiles; }, false)
                },
                comp: null,
                kind: "none",
                ae: app.version
            };
            var item = p.activeItem;
            if (item instanceof CompItem) {
                out.kind = "comp";
                out.comp = {
                    id: item.id, name: item.name, w: item.width, h: item.height, fps: item.frameRate,
                    time: item.time, frame: Math.round(item.time * item.frameRate), duration: item.duration,
                    layers: item.numLayers,
                    res: tryGet(function () { return item.resolutionFactor; }, [1, 1])
                };
            } else if (item) {
                out.kind = (item instanceof FootageItem) ? "footage" : "folder";
            }
            return val(out);
        } catch (e) {
            return fail(String(e));
        }
    }

    function capture(path) {
        try {
            var comp = app.project.activeItem;
            if (!(comp instanceof CompItem)) { return fail("Open a composition and make it the active item."); }
            var f = new File(path);
            if (f.exists) { f.remove(); }
            var t = comp.time;
            comp.saveFrameToPng(t, f);
            return val({ ok: true, time: t, frame: Math.round(t * comp.frameRate), comp: comp.id });
        } catch (e) {
            return fail(String(e));
        }
    }

    $.global.ScopesHost = { snapshot: snapshot, capture: capture };
})();
