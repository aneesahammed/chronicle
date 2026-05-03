(function () {
  "use strict";

  var refreshPending = false;

  function injectStyles() {
    if (document.getElementById("pwaUpdateStyles")) return;
    var style = document.createElement("style");
    style.id = "pwaUpdateStyles";
    style.textContent = [
      ".pwa-update{position:fixed;right:max(18px,calc((100vw - 1080px)/2 + 18px));bottom:max(18px,env(safe-area-inset-bottom));z-index:60;display:flex;align-items:center;gap:10px;max-width:min(420px,calc(100vw - 36px));padding:10px 12px;border:1px solid var(--rule);background:color-mix(in srgb,var(--panel) 94%,transparent);color:var(--ink-2);box-shadow:0 10px 30px rgba(0,0,0,.12);font:11px/1.4 var(--font-mono);letter-spacing:.03em}",
      ".pwa-update[hidden]{display:none}",
      ".pwa-update strong{color:var(--ink);font-weight:500}",
      ".pwa-update button{border:0;background:none;color:var(--ink-3);cursor:pointer;padding:4px 0;font:inherit;text-decoration:underline;text-decoration-color:var(--rule);text-underline-offset:4px}",
      ".pwa-update button:hover{color:var(--accent-2);text-decoration-color:var(--accent)}",
      ".pwa-update .pwa-update-action{color:var(--accent)}",
      "@media (max-width:720px){.pwa-update{left:18px;right:18px;justify-content:space-between}}",
    ].join("");
    document.head.appendChild(style);
  }

  function ensureToast() {
    injectStyles();
    var existing = document.getElementById("pwaUpdateNotice");
    if (existing) return existing;

    var toast = document.createElement("div");
    toast.id = "pwaUpdateNotice";
    toast.className = "pwa-update";
    toast.hidden = true;
    toast.setAttribute("role", "status");

    var message = document.createElement("strong");
    message.textContent = "New Chronicle build ready.";

    var action = document.createElement("button");
    action.type = "button";
    action.className = "pwa-update-action";
    action.textContent = "Refresh";

    var dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.textContent = "Dismiss";
    dismiss.addEventListener("click", function () {
      toast.hidden = true;
    });

    toast.append(message, action, dismiss);
    document.body.appendChild(toast);
    return toast;
  }

  function showUpdateToast(registration) {
    if (!document.body) {
      window.addEventListener("DOMContentLoaded", function () {
        showUpdateToast(registration);
      }, { once: true });
      return;
    }

    var toast = ensureToast();
    var action = toast.querySelector(".pwa-update-action");
    if (!action) return;
    action.onclick = function () {
      if (!registration.waiting) return;
      action.disabled = true;
      action.textContent = "Refreshing...";
      registration.waiting.postMessage({ type: "SKIP_WAITING" });
    };
    toast.hidden = false;
  }

  function wireLifecycle(registration) {
    if (!registration || !("serviceWorker" in navigator)) return;

    if (registration.waiting && navigator.serviceWorker.controller) {
      showUpdateToast(registration);
    }

    registration.addEventListener("updatefound", function () {
      var installing = registration.installing;
      if (!installing) return;
      installing.addEventListener("statechange", function () {
        if (installing.state === "installed" && navigator.serviceWorker.controller) {
          showUpdateToast(registration);
        }
      });
    });

    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (refreshPending) return;
      refreshPending = true;
      window.location.reload();
    });
  }

  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;

  navigator.serviceWorker
    .register("/sw.js", { scope: "/", updateViaCache: "none" })
    .then(wireLifecycle)
    .catch(function (error) {
      console.warn("[chronicle-pwa] service worker registration failed", error);
    });
})();
