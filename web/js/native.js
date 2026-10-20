// Native (Android APK) integration: opening links in apps, clipboard, self-updates.
// In a desktop browser (for testing) web fallbacks are used.
import { APP_VERSION } from "./version.js";

// Published by GitHub Actions to the "apk" release together with the APK.
const UPDATE_MANIFEST = "https://github.com/wladie-wladie/group-finder/releases/download/apk/update.json";
const cap = () => window.Capacitor;
export const isNative = () => !!(cap() && cap().isNativePlatform && cap().isNativePlatform());

const plugins = {};
function plugin(name) {
  if (!plugins[name]) plugins[name] = cap().registerPlugin(name);
  return plugins[name];
}

/* ---------- links: open in the VK / Telegram / Facebook app when it is installed ---------- */
export async function openUrl(url) {
  if (isNative()) {
    try { await plugin("AppLauncher").openUrl({ url }); return; } catch (_) {}
  }
  window.open(url, "_blank", "noopener");
}

/* ---------- links shared into the app ("Поделиться" → "Где разместить") ---------- */
export const shareInSupported = () => !!(isNative() && cap().isPluginAvailable && cap().isPluginAvailable("ShareIn"));
export function onShared(cb) {
  if (!shareInSupported()) return;
  plugin("ShareIn").addListener("shared", d => cb((d && d.text) || "", (d && d.subject) || ""));
}

/* ---------- clipboard ---------- */
export async function copyText(text) {
  if (isNative()) {
    try { await plugin("Clipboard").write({ string: text }); return true; } catch (_) {}
  }
  try { await navigator.clipboard.writeText(text); return true; } catch (_) {}
  try {
    const t = document.createElement("textarea");
    t.value = text; t.style.position = "fixed"; t.style.opacity = "0";
    document.body.appendChild(t); t.select();
    const ok = document.execCommand("copy");
    t.remove();
    return ok;
  } catch (_) { return false; }
}

/* ---------- self-updates ---------- */
const cmpVersion = (a, b) => {
  const pa = String(a).split(".").map(n => parseInt(n, 10) || 0), pb = String(b).split(".").map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
};

let readyBundle = null;
let checking = null;
let onReady = null;
const status = { state: "idle", detail: "", at: null };
const setStatus = (state, detail) => { status.state = state; status.detail = detail || ""; status.at = new Date(); };

export const appVersion = () => APP_VERSION;
export const updateStatus = () => Object.assign({}, status, { ready: !!readyBundle });

async function check() {
  if (readyBundle) { setStatus("ready", readyBundle.version); return status; }
  if (checking) return checking;
  checking = (async () => {
    setStatus("checking");
    try {
      const updater = plugin("CapacitorUpdater");
      let info;
      try {
        const res = await fetch(UPDATE_MANIFEST + "?t=" + Date.now(), { cache: "no-store" });
        if (!res.ok) { setStatus("error", "Сервер обновлений ответил " + res.status); return status; }
        info = await res.json();
      } catch (e) { setStatus("error", "Нет связи с сервером обновлений (" + ((e && e.message) || e) + ")"); return status; }
      if (!info || !info.version || !info.url) { setStatus("error", "Непонятный ответ сервера обновлений"); return status; }
      if (cmpVersion(info.version, APP_VERSION) <= 0) { setStatus("latest", info.version); return status; }
      setStatus("downloading", info.version);
      let bundle = null;
      try {
        const list = await updater.list();
        bundle = (list.bundles || []).find(b => b.version === info.version && b.status !== "error") || null;
      } catch (_) {}
      // The updater refuses bundles without a SHA-256 checksum (published in update.json).
      if (!bundle) bundle = await updater.download({ url: info.url, version: info.version, checksum: info.checksum || "" });
      await updater.next({ id: bundle.id });
      readyBundle = bundle;
      setStatus("ready", info.version);
      onReady && onReady(info);
    } catch (e) {
      setStatus("error", "Не удалось скачать обновление (" + ((e && e.message) || e) + ")");
    } finally { checking = null; }
    return status;
  })();
  return checking;
}
export const checkForUpdates = () => (isNative() ? check() : Promise.resolve(Object.assign(status, { state: "web" })));

export async function initUpdates(onUpdateReady) {
  if (!isNative()) return;
  onReady = onUpdateReady;
  // Tell the updater this version started fine; otherwise it rolls back to the previous one.
  try { await plugin("CapacitorUpdater").notifyAppReady(); } catch (e) { setStatus("error", "Модуль обновлений не отвечает (" + ((e && e.message) || e) + ")"); }
  check();
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") check(); });
}

export async function applyUpdateNow() {
  if (!readyBundle) return;
  await plugin("CapacitorUpdater").set({ id: readyBundle.id });
}
