(function () {
  "use strict";

  var HIDE_DELAY_MS = 4000;
  var FADE_MS = 220;

  var hideTimer = null;
  var fadeTimer = null;
  var toastEl = null;
  var messageEl = null;

  var TYPE_CLASSES = [
    "notification-toast--info",
    "notification-toast--warning",
    "notification-toast--success",
    "notification-toast--error",
  ];

  function getElements() {
    if (!toastEl) {
      toastEl = document.getElementById("notification-toast");
      messageEl = toastEl
        ? toastEl.querySelector(".notification-toast__message")
        : null;
    }

    return toastEl && messageEl;
  }

  function clearTimers() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }

    if (fadeTimer) {
      clearTimeout(fadeTimer);
      fadeTimer = null;
    }
  }

  function hideNotification() {
    if (!toastEl) {
      return;
    }

    toastEl.classList.remove("is-visible");

    fadeTimer = window.setTimeout(function () {
      toastEl.hidden = true;
      toastEl.classList.remove.apply(toastEl.classList, TYPE_CLASSES);
      fadeTimer = null;
    }, FADE_MS);
  }

  function showNotification(message, type) {
    if (!getElements()) {
      return;
    }

    type = type || "info";
    if (TYPE_CLASSES.indexOf("notification-toast--" + type) === -1) {
      type = "info";
    }

    clearTimers();
    toastEl.classList.remove.apply(toastEl.classList, TYPE_CLASSES);
    toastEl.classList.add("notification-toast--" + type);
    messageEl.textContent = String(message || "");

    toastEl.hidden = false;
    void toastEl.offsetWidth;
    toastEl.classList.add("is-visible");

    hideTimer = window.setTimeout(hideNotification, HIDE_DELAY_MS);
  }

  window.showNotification = showNotification;
})();
