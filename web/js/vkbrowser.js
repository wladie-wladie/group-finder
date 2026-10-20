// VKontakte search without the VK API: VK's own community search is loaded in a hidden
// browser inside the app, scrolled automatically, and the communities on the page are
// turned into cards. The browser is shown only once, if VK asks the user to sign in.
import { isNative } from "./native.js";

const cap = () => window.Capacitor;
const available = () => !!(isNative() && cap().isPluginAvailable && cap().isPluginAvailable("InAppBrowser"));
let IAB = null;
const iab = () => (IAB = IAB || cap().registerPlugin("InAppBrowser"));
export const collectorSupported = available;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Where and how to search on each network.
const NETS = {
  vk: { searchUrl: q => "https://vk.com/search/communities?q=" + encodeURIComponent(q), title: "Вход во ВКонтакте", name: "ВКонтакте", pause: [600, 1400] },
  fb: { searchUrl: q => "https://m.facebook.com/search/groups/?q=" + encodeURIComponent(q), title: "Вход в Facebook", name: "Facebook", pause: [2500, 4500] },
};

// Runs inside the network's page. QI is the query number, so late messages from an old page are ignored.
const collector = (qi, net) => `(async () => {
  const QI = ${qi}, NET = "${net}";
  if (window.__gfRun === QI) return;
  window.__gfRun = QI;
  const send = m => { try { m.qi = QI; window.mobileApp.postMessage({ detail: m }); } catch (e) {} };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const loginPage = () => /(^|\\.)id\\.vk\\.(com|ru)$/.test(location.hostname) || /^\\/(login|auth|join|checkpoint)/.test(location.pathname) || !!document.querySelector('input[type="password"]');
  if (loginPage()) { send({ type: "needLogin" }); return; }
  const SKIP = /^(feed|search|im|friends|groups|audio|audios|video|videos|clips|music|apps|services|settings|notifications|login|join|restore|support|legal|about|blog|dev|ads|pay|market|vkpay|bugs|docs|games|stickers|gifts|bookmarks|fave|photos|albums|wall|id\\d+|away\\.php|.*\\.php)$/i;
  const COUNT = /(\\d[\\d\\s\\u00a0.,]*)\\s*(тыс\\.?|млн|K|M)?\\s*(участник|подписчик|member|subscriber|follower)/i;
  const COUNT_FB = /(?:участники|members)\\s*:?\\s*(\\d[\\d\\s\\u00a0.,]*)\\s*(тыс\\.?|млн|K|M)?/i;
  const num = (s, mult) => {
    let n = parseFloat(String(s).replace(/[\\s\\u00a0]/g, "").replace(",", "."));
    if (/тыс|K/i.test(mult || "")) n *= 1000;
    if (/млн|M/.test(mult || "")) n *= 1e6;
    return Math.round(n) || 0;
  };
  const sent = new Set();
  const scan = () => {
    const items = [];
    document.querySelectorAll("a[href]").forEach(a => {
      let u;
      try { u = new URL(a.getAttribute("href"), location.href); } catch (e) { return; }
      const parts = u.pathname.split("/").filter(Boolean);
      let slug = null;
      if (NET === "vk") {
        if (!/(^|\\.)vk\\.(com|ru)$/.test(u.hostname) || parts.length !== 1) return;
        slug = parts[0];
        if (!/^[A-Za-z0-9_.]{2,}$/.test(slug) || SKIP.test(slug)) return;
      } else {
        if (!/(^|\\.)facebook\\.com$/.test(u.hostname) || parts[0] !== "groups" || !parts[1] || parts.length > 3) return;
        slug = parts[1];
        if (!/^[A-Za-z0-9_.-]{2,}$/.test(slug) || /^(feed|discover|joins|create|search|category|notifications|you)$/i.test(slug)) return;
      }
      if (sent.has(slug.toLowerCase())) return;
      const title = (a.textContent || a.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim();
      if (!title || title.length > 150) return;
      // Nearest block around the link with exactly one member count = one search result.
      let box = a, text = "";
      for (let i = 0; i < 7 && box; i++) {
        box = box.parentElement;
        if (!box) break;
        text = (box.innerText || "").slice(0, 600);
        const all = (text.match(new RegExp(COUNT.source, "gi")) || []).concat(text.match(new RegExp(COUNT_FB.source, "gi")) || []);
        if (all.length > 1) { box = null; break; }
        if (all.length === 1) break;
      }
      if (!box) return;
      const m = text.match(COUNT) || text.match(COUNT_FB);
      if (!m) return;
      sent.add(slug.toLowerCase());
      items.push({ slug, title, members: num(m[1], m[2]), closed: /закрыт|частная|private group|closed group/i.test(text), about: text.replace(title, "").replace(/\\s+/g, " ").trim().slice(0, 200) });
    });
    if (items.length) send({ type: "groups", items });
    return items.length;
  };
  await sleep(1800);
  let idle = 0;
  for (let round = 0; round < 12 && idle < 2; round++) {
    const n = scan();
    idle = n ? 0 : idle + 1;
    window.scrollTo(0, document.documentElement.scrollHeight || document.body.scrollHeight);
    await sleep(1400);
  }
  scan();
  if (!sent.size && /войдите|войти|авторизу|sign in|log in/i.test(((document.body && document.body.innerText) || "").slice(0, 4000))) {
    send({ type: "needLogin" });
    return;
  }
  send({ type: "pageDone", count: sent.size });
})();`;

const LOGIN_BANNER = `(() => {
  if (document.getElementById("gf-login")) return;
  const b = document.createElement("div");
  b.id = "gf-login";
  b.style.cssText = "position:fixed;left:8px;right:8px;top:8px;z-index:2147483647;background:#2B3FD6;color:#fff;border-radius:12px;padding:10px 12px;font:14px/1.35 system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.35)";
  b.textContent = "Войдите один раз — после входа «Где разместить» продолжит поиск сам и закроет это окно.";
  (document.body || document.documentElement).appendChild(b);
})();`;

let run = null;

// Searches the network for every query and resolves with the groups found.
// onProgress({ i, n, found, login }) reports progress for the app's progress bar.
export const collectVk = (queries, onProgress) => collect("vk", queries, onProgress);
export const collectFb = (queries, onProgress) => collect("fb", queries, onProgress);

async function collect(net, queries, onProgress) {
  if (!available()) throw new Error("Для этого поиска установите новую версию APK.");
  const cfg = NETS[net];
  const searchUrl = cfg.searchUrl;
  if (run) await run.stop();

  const groups = new Map();
  let id = null, qi = 0, loginShown = false, stopped = false;
  let pageDone = null; // resolves when the current query finishes
  const listeners = [];
  const withId = o => (id ? Object.assign({ id }, o) : o);
  const report = extra => onProgress && onProgress(Object.assign({ i: qi + 1, n: queries.length, found: groups.size, login: loginShown }, extra || {}));
  const banner = () => iab().executeScript(withId({ code: LOGIN_BANNER })).catch(() => {});
  const injectCollector = () => iab().executeScript(withId({ code: collector(qi, net) })).catch(() => {});

  const finished = new Promise(resolve => {
    run = {
      stop: async () => {
        if (stopped) return;
        stopped = true;
        if (pageDone) pageDone();
        listeners.forEach(h => { try { h.remove(); } catch (_) {} });
        try { await iab().close(withId({})); } catch (_) {}
        run = null;
        resolve();
      },
    };
  });

  listeners.push(await iab().addListener("browserPageLoaded", () => {
    if (stopped) return;
    if (loginShown) banner(); else injectCollector();
  }));
  listeners.push(await iab().addListener("urlChangeEvent", async ev => {
    if (stopped || !loginShown) return;
    const url = String((ev && ev.url) || "");
    // Signed in: the browser leaves id.vk.* and the login pages.
    const home = net === "vk" ? /^https:\/\/(m\.)?vk\.(com|ru)\//.test(url) : /^https:\/\/(m\.|www\.)?facebook\.com\//.test(url);
    if (home && !/\/(login|auth|join|checkpoint|recover)/.test(url)) {
      loginShown = false;
      await sleep(1500);
      try { await iab().hide(withId({})); } catch (_) {}
      report();
      iab().setUrl(withId({ url: searchUrl(queries[qi]) })).catch(() => {});
    } else {
      setTimeout(banner, 800);
    }
  }));
  listeners.push(await iab().addListener("closeEvent", () => run && run.stop()));
  listeners.push(await iab().addListener("messageFromWebview", async ev => {
    const d = (ev && ev.detail) || {};
    if (stopped || d.qi !== qi) return;
    if (d.type === "groups") {
      (d.items || []).forEach(it => {
        if (it.closed && net === "vk") return; // closed VK groups: posting is impossible
        const key = net + ":" + String(it.slug).toLowerCase();
        const ex = groups.get(key);
        if (ex) { if (!ex.queries.includes(queries[qi])) ex.queries.push(queries[qi]); return; }
        groups.set(key, {
          key, platform: net, title: String(it.title).slice(0, 120),
          url: net === "vk" ? "https://vk.com/" + it.slug : "https://www.facebook.com/groups/" + it.slug,
          privateGroup: net === "fb" && !!it.closed,
          members: Number(it.members) || 0, description: String(it.about || ""), viaBrowser: true,
          canPost: false, canSuggest: false, closed: false, queries: [queries[qi]],
        });
      });
      report();
    } else if (d.type === "pageDone") {
      if (pageDone) pageDone();
    } else if (d.type === "needLogin") {
      if (loginShown) return;
      loginShown = true;
      report({ login: true });
      try { await iab().show(withId({})); } catch (_) {}
      banner();
    }
  }));

  // Walk through the queries one by one.
  (async () => {
    try {
      for (qi = 0; qi < queries.length && !stopped; qi++) {
        report();
        const done = new Promise(r => { pageDone = r; });
        if (qi === 0) {
          const r = await iab().openWebView({
            url: searchUrl(queries[0]),
            title: cfg.title,
            toolbarType: "activity",
            preventDeeplink: true,
            hidden: true,
            invisibilityMode: "FAKE_VISIBLE",
          });
          id = (r && r.id) || null;
          setTimeout(() => { if (!loginShown) injectCollector(); }, 2500); // in case the load event came before we listened
        } else {
          await iab().setUrl(withId({ url: searchUrl(queries[qi]) }));
        }
        // Each query gets up to 40 s; while the user is signing in, the clock waits.
        let waited = 0;
        while (!stopped) {
          const t = await Promise.race([done.then(() => "done"), sleep(1000).then(() => "tick")]);
          if (t === "done") break;
          if (!loginShown) waited += 1000;
          if (waited >= 40000) break;
        }
        pageDone = null;
        if (!stopped) await sleep(cfg.pause[0] + Math.random() * (cfg.pause[1] - cfg.pause[0])); // a human pace between searches
      }
    } catch (_) {
      // the browser failed to open: return what we have
    }
    if (run) await run.stop();
  })();

  await finished;
  return [...groups.values()];
}

export const stopVk = () => (run ? run.stop() : Promise.resolve());
export const COLLECTOR_FOR_TEST = collector;
