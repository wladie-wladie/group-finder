// VKontakte search inside the app: VK's own community search opens in a built-in browser
// (the user signs in to VK there once, like in any browser), and the app collects the
// communities shown on the page into cards. Free, no business account needed.
import { isNative } from "./native.js";

const cap = () => window.Capacitor;
const available = () => !!(isNative() && cap().isPluginAvailable && cap().isPluginAvailable("InAppBrowser"));
let IAB = null;
const iab = () => (IAB = IAB || cap().registerPlugin("InAppBrowser"));
export const collectorSupported = available;

const searchUrl = q => "https://vk.com/search/communities?q=" + encodeURIComponent(q);

// Injected into vk.com pages. Finds community links that sit next to a member count,
// shows a bar with the progress and buttons, and sends new finds to the app.
const INJECT = `(() => {
  if (window.__gfCollector) { window.__gfCollector.scan(); return; }
  const SKIP = /^(feed|search|im|friends|groups|audio|audios|video|videos|clips|music|apps|services|settings|notifications|login|join|restore|support|legal|about|blog|dev|ads|pay|market|vkpay|bugs|docs|games|stickers|gifts|bookmarks|fave|photos|albums|wall|id\\d+|away\\.php|.*\\.php)$/i;
  const COUNT = /(\\d[\\d\\s\\u00a0.,]*)\\s*(тыс\\.?|млн|K|M)?\\s*(участник|подписчик|member|subscriber|follower)/i;
  const sent = new Set();
  let found = 0;
  const bar = document.createElement("div");
  bar.id = "gf-bar";
  bar.style.cssText = "position:fixed;left:8px;right:8px;bottom:8px;z-index:2147483647;background:#2B3FD6;color:#fff;border-radius:14px;padding:10px 12px;font:14px/1.3 system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.35)";
  bar.innerHTML = '<div id="gf-info" style="margin-bottom:8px">Ищу сообщества на странице…</div>' +
    '<div style="display:flex;gap:8px"><button id="gf-next" style="flex:1;border:0;border-radius:10px;padding:10px;font-weight:700;background:#fff;color:#2B3FD6">Следующий запрос</button>' +
    '<button id="gf-done" style="flex:1;border:0;border-radius:10px;padding:10px;font-weight:700;background:#FFC43D;color:#171A2C">Готово</button></div>';
  const mount = () => { if (!document.getElementById("gf-bar") && document.body) document.body.appendChild(bar); };
  mount();
  let label = "";
  const info = () => {
    const el = bar.querySelector("#gf-info");
    if (el) el.textContent = (label ? label + ". " : "") + (found ? "Собрано на этой странице: " + found + ". Прокрутите вниз, чтобы найти ещё." : "Сообществ пока не видно. Если ВК просит войти — войдите.");
  };
  const send = m => { try { window.mobileApp.postMessage({ detail: m }); } catch (e) {} };
  bar.querySelector("#gf-next").onclick = () => send({ type: "next" });
  bar.querySelector("#gf-done").onclick = () => send({ type: "done" });
  window.addEventListener("messageFromNative", e => {
    const d = (e && e.detail) || e || {};
    if (d.label) { label = d.label; info(); }
    const nb = bar.querySelector("#gf-next");
    if (nb && d.last) nb.textContent = "Готово, это последний";
  });
  const num = (s, mult) => {
    let n = parseFloat(String(s).replace(/[\\s\\u00a0]/g, "").replace(",", "."));
    if (/тыс|K/i.test(mult || "")) n *= 1000;
    if (/млн|M/.test(mult || "")) n *= 1e6;
    return Math.round(n) || 0;
  };
  const scan = () => {
    mount();
    const items = [];
    document.querySelectorAll("a[href]").forEach(a => {
      if (a.closest("#gf-bar")) return;
      let u;
      try { u = new URL(a.getAttribute("href"), location.href); } catch (e) { return; }
      if (!/(^|\\.)vk\\.(com|ru)$/.test(u.hostname)) return;
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts.length !== 1) return;
      const slug = parts[0];
      if (!/^[A-Za-z0-9_.]{2,}$/.test(slug) || SKIP.test(slug) || sent.has(slug.toLowerCase())) return;
      const title = (a.textContent || a.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim();
      if (!title || title.length > 150) return;
      // The nearest block around the link that mentions exactly one member count = one search result.
      let box = a, text = "";
      for (let i = 0; i < 7 && box; i++) {
        box = box.parentElement;
        if (!box) break;
        text = (box.innerText || "").slice(0, 600);
        const all = text.match(new RegExp(COUNT.source, "gi")) || [];
        if (all.length > 1) { box = null; break; }
        if (all.length === 1) break;
      }
      if (!box) return;
      const m = text.match(COUNT);
      if (!m) return;
      sent.add(slug.toLowerCase());
      items.push({ slug, title, members: num(m[1], m[2]), closed: /закрыт|частная|private group|closed group/i.test(text), about: text.replace(title, "").replace(/\\s+/g, " ").trim().slice(0, 200) });
    });
    if (items.length) { found += items.length; send({ type: "groups", items }); }
    info();
  };
  window.__gfCollector = { scan };
  scan();
  setInterval(scan, 1500);
})();`;

let state = null; // { id, queries, i, groups: Map, resolve }

function label() {
  const n = state.queries.length;
  return { label: "Запрос " + (state.i + 1) + " из " + n + ": «" + state.queries[state.i] + "»", last: state.i + 1 >= n };
}

const withId = o => (state && state.id ? Object.assign({ id: state.id }, o) : o);

async function inject() {
  if (!state) return;
  try {
    await iab().executeScript(withId({ code: INJECT }));
    await iab().postMessage(withId({ detail: label() }));
  } catch (_) {}
}

function finish() {
  if (!state) return;
  const s = state; state = null;
  try { iab().close(s.id ? { id: s.id } : {}).catch(() => {}); } catch (_) {}
  listeners.forEach(h => { try { h.remove(); } catch (_) {} });
  listeners = [];
  s.resolve([...s.groups.values()]);
}

let listeners = [];
// Opens VK search for each query in turn; resolves with the collected groups when the user taps "Готово"
// or closes the browser. onFound(total) is called as groups are collected.
export async function collectVk(queries, onFound) {
  if (!available()) throw new Error("Для сбора групп ВК установите новую версию APK.");
  if (state) finish();
  return new Promise(async (resolve, reject) => {
    state = { id: null, queries, i: 0, groups: new Map(), resolve };
    try {
      listeners.push(await iab().addListener("browserPageLoaded", () => inject()));
      listeners.push(await iab().addListener("urlChangeEvent", () => setTimeout(inject, 800)));
      listeners.push(await iab().addListener("closeEvent", () => finish()));
      listeners.push(await iab().addListener("messageFromWebview", ev => {
        if (!state) return;
        const d = (ev && ev.detail) || {};
        if (d.type === "groups") {
          (d.items || []).forEach(it => {
            if (it.closed) return;
            const key = "vk:" + String(it.slug).toLowerCase();
            const ex = state.groups.get(key);
            if (ex) { if (!ex.queries.includes(state.queries[state.i])) ex.queries.push(state.queries[state.i]); return; }
            state.groups.set(key, {
              key, platform: "vk", title: String(it.title).slice(0, 120), url: "https://vk.com/" + it.slug,
              members: Number(it.members) || 0, description: String(it.about || ""), viaBrowser: true,
              canPost: false, canSuggest: false, closed: false, queries: [state.queries[state.i]],
            });
          });
          onFound && onFound(state.groups.size);
        } else if (d.type === "next") {
          if (state.i + 1 >= state.queries.length) { finish(); return; }
          state.i++;
          iab().setUrl(withId({ url: searchUrl(state.queries[state.i]) })).catch(() => {});
        } else if (d.type === "done") {
          finish();
        }
      }));
      const r = await iab().openWebView({
        url: searchUrl(queries[0]),
        title: "Поиск ВКонтакте",
        toolbarType: "activity",
        preventDeeplink: true,
        activeNativeNavigationForWebview: true,
        isPresentAfterPageLoad: false,
      });
      if (state) state.id = r && r.id;
      setTimeout(inject, 1500);
    } catch (e) {
      finish();
      reject(e);
    }
  });
}
export const INJECT_FOR_TEST = INJECT;
