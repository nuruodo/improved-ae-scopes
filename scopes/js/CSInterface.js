/* Minimal CSInterface shim for the Adobe CEP ExtendScript bridge. */
function CSInterface() {}

CSInterface.prototype.evalScript = function (script, callback) {
  if (callback === null || callback === undefined) {
    callback = function () {};
  }
  if (window.__adobe_cep__) {
    window.__adobe_cep__.evalScript(script, callback);
  } else {
    callback("EvalScript error.");
  }
};

/* "extension" -> folder this panel was loaded from, as a plain file-system path. */
CSInterface.prototype.getSystemPath = function (pathType) {
  if (!window.__adobe_cep__) {
    return "";
  }
  var uri = decodeURI(window.__adobe_cep__.getSystemPath(pathType));
  var path = uri.replace(/^file:\/\/\//, "").replace(/^file:\/\//, "");
  if (/^[A-Za-z]:/.test(path)) {
    return path;
  }
  return path.charAt(0) === "/" ? path : "/" + path;
};
