import * as store from "./store.js";
import { analyzePost, scoreGroups, quickRules, checkKey, MODELS } from "./ai.js";
import { vkCheck, vkSearch, tgSearch, tgCheck } from "./sources.js";
import * as vkid from "./vkid.js";
import { webSearchGroups } from "./websearch.js";
import { SEARCH, parseGroupLink, manualGroup, fetchMeta } from "./links.js";
import * as tg from "./tg.js";
import { collectVk, collectFb, collectorSupported } from "./vkbrowser.js";
import { openUrl, copyText, onShared, shareInSupported, initUpdates, checkForUpdates, applyUpdateNow, appVersion, updateStatus, isNative } from "./native.js";

const $ = id => document.getElementById(id);
const S = store.settings;
const D = store.draft;
const PAGE = 40;

const ui = { tab: "post", platform: "all", onlyPostable: S.onlyPostable, hideForbidden: S.hideForbidden, shown: PAGE, hist: "posted", busy: false, errors: [] };

const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const PLAT = { vk: "ВКонтакте", tg: "Telegram", fb: "Facebook" };

function fmtMembers(n) {
  if (!n) return "";
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(".", ",") + " млн";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(".", ",") + " тыс";
  return String(n);
}
function ago(ts) {
  const d = Math.floor((Date.now() - ts) / 86400000);
  if (d <= 0) return "сегодня";
  if (d === 1) return "вчера";
  const w = d % 10 === 1 && d % 100 !== 11 ? "день" : [2, 3, 4].includes(d % 10) && ![12, 13, 14].includes(d % 100) ? "дня" : "дней";
  return d + " " + w + " назад";
}

/* ---------- toast ---------- */
let toastTimer = null;
function toast(text, action, onAction) {
  const t = $("toast");
  t.innerHTML = "<span>" + esc(text) + "</span>" + (action ? "<button>" + esc(action) + "</button>" : "");
  t.hidden = false;
  if (action) t.querySelector("button").onclick = () => { t.hidden = true; onAction(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, action ? 5000 : 3200);
}

/* ---------- tabs ---------- */
function showTab(name) {
  ui.tab = name;
  document.querySelectorAll(".tab").forEach(s => { s.hidden = s.id !== "tab-" + name; });
  document.querySelectorAll(".tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === name));
  if (name === "history") renderHistory();
  if (name === "groups") renderResults();
  if (name === "settings") renderSettings();
  window.scrollTo(0, 0);
}

/* ---------- post & analysis ---------- */
function renderAiHint() {
  $("aiModeHint").innerHTML = S.claudeKey
    ? "Разбирает Claude. Он поймёт суть услуги и подскажет, где искать аудиторию."
    : 'Бесплатный режим: запросы подбираются по словам из поста — поправьте их, если нужно. Умный разбор через Claude можно включить в <button class="link" data-goto="settings">настройках</button>.';
}

function renderAnalysis() {
  const a = D.analysis;
  $("analysis").hidden = !a;
  if (!a) return;
  $("summaryBox").innerHTML = a.summary || (a.audience && a.audience.length) || a.tips
    ? '<div class="summary">' +
        (a.summary ? "<p><b>" + esc(a.summary) + "</b></p>" : "") +
        (a.audience && a.audience.length ? '<div class="aud">' + a.audience.map(x => "<span>" + esc(x) + "</span>").join("") + "</div>" : "") +
        (a.tips ? '<p class="tips">' + esc(a.tips) + "</p>" : "") +
      "</div>"
    : "";
  $("queries").innerHTML = D.queries.length
    ? D.queries.map((q, i) => '<span class="chip">' + esc(q) + '<button aria-label="Убрать запрос" data-rmq="' + i + '">×</button></span>').join("")
    : '<p class="hint">Запросов нет. Добавьте хотя бы один.</p>';
  renderPlatforms();
}

// How each network will be searched right now: "api" / "tgstat" (automatic, free or own paid token),
// "web" (Claude web search, paid, only when switched on) or "links" (free: ready search links).
function platformState() {
  const web = !!S.claudeKey && !!S.webSearch;
  const vkApi = vkid.isSignedIn() && !S.vkApiBlocked;
  const tgstat = S.tgEnabled && !!S.tgstatToken;
  return {
    vk: true, vkHow: vkApi ? "api" : web ? "web" : S.autoCollect && collectorSupported() ? "browser" : "links",
    tg: true, tgHow: tgstat ? "tgstat" : tg.isSignedIn() ? "tgacc" : web ? "web" : "links",
    fb: S.fbEnabled, fbHow: web ? "web" : S.autoCollect && collectorSupported() ? "browser" : "links",
  };
}
const HOW = { api: "автоматически", web: "поиск Claude", links: "сами, по ссылкам", tgstat: "TGStat API", tgacc: "автоматически", browser: "автоматически" };
function renderPlatforms() {
  const st = platformState();
  const sel = D.platforms || { vk: true, tg: true, fb: true };
  const item = (k, sub) => {
    const off = !st[k];
    return '<label class="plat"><input type="checkbox" data-plat="' + k + '"' + (sel[k] && !off ? " checked" : "") + (off ? " disabled" : "") + "> " + PLAT[k] + (sub ? " <small>" + sub + "</small>" : "") + "</label>";
  };
  $("platforms").innerHTML =
    item("vk", HOW[st.vkHow]) +
    item("tg", HOW[st.tgHow]) +
    item("fb", st.fb ? HOW[st.fbHow] : "выкл.");
}

async function onAnalyze() {
  const text = $("postText").value.trim();
  if (text.length < 15) { toast("Напишите текст поста — хотя бы пару предложений о услуге."); return; }
  store.saveDraft({ text, city: $("city").value.trim(), audience: $("audience").value.trim() });
  const btn = $("analyzeBtn");
  btn.disabled = true; btn.textContent = S.claudeKey ? "Claude разбирает пост…" : "Подбираю запросы…";
  try {
    const a = await analyzePost({ key: S.claudeKey, model: S.model, text, city: D.city, audience: D.audience });
    store.saveDraft({ analysis: a, queries: a.queries });
    renderAnalysis();
    $("analysis").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    toast(e.message || String(e));
  } finally {
    btn.disabled = false; btn.textContent = "Разобрать пост";
  }
}

/* ---------- search ---------- */
function setProgress(text, frac) {
  const p = $("progress");
  if (text == null) { p.hidden = true; return; }
  p.hidden = false;
  p.querySelector("span").textContent = text;
  p.querySelector(".progress-fill").style.width = Math.round((frac || 0) * 100) + "%";
}

async function onSearch() {
  if (ui.busy) return;
  if (!D.queries.length) { toast("Добавьте хотя бы один запрос."); return; }
  const st = platformState();
  const sel = {};
  document.querySelectorAll("[data-plat]").forEach(c => { sel[c.dataset.plat] = c.checked; });
  store.saveDraft({ platforms: sel });
  const use = { vk: sel.vk && st.vk, tg: sel.tg && st.tg, fb: sel.fb && st.fb };
  if (!use.vk && !use.tg && !use.fb) { toast("Выберите хотя бы одну площадку."); return; }

  ui.busy = true; ui.errors = []; ui.shown = PAGE;
  $("searchBtn").disabled = true;
  showTab("groups");
  $("results").innerHTML = "";
  renderErrors();
  let found = [];
  const manual = { vk: false, tg: false, fb: false }; // networks to search by hand
  const qs = D.queries;
  try {
    const web = async (platform, from, to) => {
      setProgress("Claude ищет группы: " + PLAT[platform] + "…", from);
      const list = await webSearchGroups({ key: S.claudeKey, model: S.model, platform, queries: qs, summary: D.analysis && D.analysis.summary, city: D.city });
      setProgress(PLAT[platform] + ": найдено " + list.length, to);
      return list;
    };
    if (use.vk) {
      let how = st.vkHow;
      if (how === "api") {
        try {
          const vk = await vkSearch(qs, vkid.getToken, (i, n) => setProgress("ВКонтакте: запрос " + i + " из " + n, i / n * 0.5));
          found = found.concat(vk.filter(g => !g.closed));
        } catch (e) {
          if (/profile type|тип профиля/i.test(e.message)) {
            // VK gives group search only to verified business apps.
            store.saveSettings({ vkApiBlocked: true });
            how = S.claudeKey && S.webSearch ? "web" : S.autoCollect && collectorSupported() ? "browser" : "links";
          } else { ui.errors.push(e.message); renderErrors(); how = "links"; }
        }
      }
      if (how === "web") {
        try { found = found.concat(await web("vk", 0.05, 0.4)); } catch (e) { ui.errors.push("ВКонтакте: " + e.message); renderErrors(); manual.vk = true; }
      }
      if (how === "browser") {
        try {
          const vk = await collectVk(qs, p => setProgress(p.login
            ? "ВКонтакте просит войти — войдите в открывшемся окне, поиск продолжится сам"
            : "ВКонтакте: запрос " + p.i + " из " + p.n + ", найдено групп: " + p.found, (p.i - 1) / p.n * 0.5));
          found = found.concat(vk);
          if (!vk.length) { ui.errors.push("Во ВКонтакте ничего не нашлось. Попробуйте другие запросы."); renderErrors(); }
        } catch (e) { ui.errors.push(e.message || String(e)); renderErrors(); manual.vk = true; }
      }
      if (how === "links") manual.vk = true;
    }
    if (use.tg) {
      if (st.tgHow === "tgstat") {
        try {
          const tg = await tgSearch(qs, S.tgstatToken, (i, n) => setProgress("Telegram: запрос " + i + " из " + n, 0.5 + i / n * 0.2));
          found = found.concat(tg);
        } catch (e) { ui.errors.push(e.message); renderErrors(); manual.tg = true; }
      } else if (st.tgHow === "tgacc") {
        try {
          const list = await tg.tgAccountSearch(qs, (i, n) => setProgress("Telegram: запрос " + i + " из " + n, 0.5 + i / n * 0.3));
          found = found.concat(list);
        } catch (e) { ui.errors.push(e.message); renderErrors(); manual.tg = true; }
      } else if (st.tgHow === "web") {
        try { found = found.concat(await web("tg", 0.4, 0.6)); } catch (e) { ui.errors.push("Telegram: " + e.message); renderErrors(); manual.tg = true; }
      } else manual.tg = true;
    }
    if (use.fb) {
      if (st.fbHow === "browser") {
        try {
          const list = await collectFb(qs, p => setProgress(p.login
            ? "Facebook просит войти — войдите в открывшемся окне, поиск продолжится сам"
            : "Facebook: запрос " + p.i + " из " + p.n + ", найдено групп: " + p.found, 0.6 + (p.i - 1) / p.n * 0.2));
          found = found.concat(list);
          if (!list.length) { ui.errors.push("В Facebook ничего не нашлось. Попробуйте другие запросы."); renderErrors(); }
        } catch (e) { ui.errors.push(e.message || String(e)); renderErrors(); manual.fb = true; }
      } else if (st.fbHow === "web") {
        try { found = found.concat(await web("fb", 0.6, 0.78)); } catch (e) { ui.errors.push("Facebook: " + e.message); renderErrors(); manual.fb = true; }
      } else manual.fb = true;
    }
    found = found.filter(g => !store.isBlocked(g.key));
    found.forEach(quickRules);
    if (S.claudeKey && found.length) {
      setProgress("Claude оценивает группы и читает правила…", 0.82);
      try {
        await scoreGroups({
          key: S.claudeKey, model: S.model,
          summary: D.analysis && D.analysis.summary, text: D.text,
          groups: found,
          onProgress: (i, n) => setProgress("Claude оценил " + i + " из " + n + " групп", 0.82 + i / n * 0.18),
        });
      } catch (e) { ui.errors.push("Оценка групп не удалась: " + e.message + " Список показан без оценки."); renderErrors(); }
    }
    const anyManual = manual.vk || manual.tg || manual.fb;
    store.saveDraft({ results: found, searchedAt: Date.now(), manual: anyManual ? { queries: qs.slice(), nets: manual } : null });
  } finally {
    ui.busy = false;
    $("searchBtn").disabled = false;
    setProgress(null);
    renderResults();
  }
}

/* ---------- free mode: search by hand ---------- */
function renderSearchBox() {
  const m = D.manual;
  if (!m || !m.queries || !m.queries.length) { $("searchBox").innerHTML = ""; return; }
  let html = "";
  const nets = ["vk", "tg", "fb"].filter(k => m.nets[k]);
  if (nets.length) {
    const tgTip = m.nets.tg ? ' Telegram приложение может искать само — <button class="link" data-goto="settings">войдите в Telegram</button>.' : "";
    html += '<div class="manual">' +
      '<h2 class="sec">Поиск по ссылкам</h2>' +
      '<p class="hint">Нажмите на площадку — откроется поиск. Подходящую группу отправьте сюда через «Поделиться» → «Где разместить» или вставьте ссылку ниже.' + tgTip + "</p>" +
      m.queries.map((q, i) => '<div class="srow"><span class="sq">' + esc(q) + "</span>" +
        nets.map(k => '<button class="sbtn ' + k + '" data-sq="' + i + '" data-sn="' + k + '">' + SEARCH[k].label + "</button>").join("") +
        "</div>").join("") +
      "</div>";
  }
  $("searchBox").innerHTML = html;
}

async function addGroupFromText(text, subject) {
  const link = parseGroupLink(text + " " + (subject || ""));
  if (!link) { toast("Не нашёл ссылку на группу ВК, канал Telegram или группу Facebook."); return; }
  const titleHint = String(text).replace(link.url, "").trim() || subject;
  const g = manualGroup(link, titleHint);
  if (store.isBlocked(g.key)) { store.unblock(g.key); }
  const added = store.addSaved(g);
  if (ui.tab !== "groups") showTab("groups"); else renderResults();
  toast(added ? "Добавлено в список" : "Эта группа уже в списке");
  if (!added) return;
  const before = JSON.stringify([g.title, g.members, g.description]);
  await fetchMeta(g);
  if (JSON.stringify([g.title, g.members, g.description]) !== before) {
    store.updateSaved(g.key, { title: g.title, members: g.members, description: g.description, tgType: g.tgType });
    renderResults();
  }
}

function renderErrors() {
  $("errors").innerHTML = ui.errors.map(e => '<div class="err">' + esc(e) + "</div>").join("");
}

function sortScore(g) {
  const posted = store.postedAt(g.key) ? -400 : 0;
  const rel = g.rel != null ? g.rel * 10 : Math.min(30, g.queries.length * 10);
  const can = g.canPost ? 8 : g.canSuggest ? 4 : 0;
  const ads = g.ads === "forbidden" ? -25 : g.ads === "allowed" ? 6 : 0;
  const size = g.members ? Math.log10(g.members + 1) * 3 : 0;
  const mine = g.manual ? 60 : 0; // groups the user picked go first
  return posted + rel + can + ads + size + mine;
}

// Groups added by hand stay on top and survive new searches.
function allGroups() {
  const seen = new Set();
  return store.savedList().concat((D.results || []).filter(g => !g.isSearch))
    .filter(g => { if (seen.has(g.key)) return false; seen.add(g.key); return true; });
}

function visibleResults() {
  return allGroups()
    .filter(g => !store.isBlocked(g.key))
    .filter(g => ui.platform === "all" || g.platform === ui.platform)
    .filter(g => !ui.onlyPostable || g.manual || g.viaWeb || g.viaBrowser || g.canPost || g.canSuggest || g.platform === "tg")
    .filter(g => !ui.hideForbidden || g.ads !== "forbidden")
    .sort((a, b) => sortScore(b) - sortScore(a));
}

function renderFilters() {
  const all = allGroups().filter(g => !store.isBlocked(g.key));
  if (!all.length) { $("filters").innerHTML = ""; return; }
  const counts = { all: all.length };
  all.forEach(g => { counts[g.platform] = (counts[g.platform] || 0) + 1; });
  const b = (attr, val, label, on) => '<button data-' + attr + '="' + val + '"' + (on ? ' class="on"' : "") + ">" + label + "</button>";
  $("filters").innerHTML =
    b("pf", "all", "Все · " + counts.all, ui.platform === "all") +
    ["vk", "tg", "fb"].filter(p => counts[p]).map(p => b("pf", p, PLAT[p] + " · " + counts[p], ui.platform === p)).join("") +
    b("flt", "postable", "Можно опубликовать", ui.onlyPostable) +
    b("flt", "forbidden", "Без запрета рекламы", ui.hideForbidden);
}

function tagsFor(g) {
  const t = [];
  if (g.rel != null) t.push('<span class="tag rel">Подходит на ' + g.rel + "/10</span>");
  if (g.manual) t.push('<span class="tag ok">Вы добавили</span>');
  else if (g.viaBrowser) t.push(g.privateGroup ? '<span class="tag warn">Частная: сначала вступите</span>' : '<span class="tag">Правила проверьте в группе</span>');
  else if (g.viaWeb) t.push('<span class="tag">Найдено поиском: правила проверьте в группе</span>');
  else if (g.platform === "vk") {
    if (g.canPost) t.push('<span class="tag ok">Можно опубликовать</span>');
    else if (g.canSuggest) t.push('<span class="tag warn">Через «Предложить новость»</span>');
    else t.push('<span class="tag">Стена закрыта</span>');
  }
  if (g.platform === "tg" && !g.viaWeb && !(g.manual && !g.tgType)) t.push(g.tgType === "chat" ? '<span class="tag ok">Чат: можно писать</span>' : '<span class="tag warn">Канал: только через админа</span>');
  if (g.ads === "forbidden") t.push('<span class="tag bad">Реклама запрещена</span>');
  else if (g.ads === "paid") t.push('<span class="tag warn">Реклама платно</span>');
  else if (g.ads === "allowed") t.push('<span class="tag ok">Объявления разрешены</span>');
  const p = store.postedAt(g.key);
  if (p) t.push('<span class="tag">Опубликовано ' + ago(p) + "</span>");
  return t.join("");
}

function groupCard(g) {
  const done = !!store.postedAt(g.key);
  return '<article class="group ' + g.platform + (done ? " done" : "") + '" data-key="' + esc(g.key) + '">' +
    '<div class="g-top"><div class="g-title">' + esc(g.title) + "</div>" +
      (g.members ? '<div class="g-members">' + fmtMembers(g.members) + "<small>" + (g.platform === "tg" && g.tgType !== "chat" ? "подписчиков" : "участников") + "</small></div>" : "") +
    "</div>" +
    (g.description ? '<p class="g-desc" data-expand>' + esc(g.description) + "</p>" : "") +
    '<div class="tags">' + tagsFor(g) + "</div>" +
    (g.note ? '<p class="g-note">' + esc(g.note) + "</p>" : "") +
    '<div class="g-acts">' +
      '<button class="a-open" data-act="open">Открыть</button>' +
      '<button class="a-done" data-act="done">' + (done ? "Ещё раз" : "Опубликовал") + "</button>" +
      '<button class="a-block" data-act="block">В блок</button>' +
    "</div></article>";
}

function renderResults() {
  renderSearchBox();
  renderFilters();
  $("shareHint").textContent = shareInSupported()
    ? "Или в приложении ВК, Telegram или в браузере нажмите «Поделиться» → «Где разместить»."
    : isNative() ? "Чтобы отправлять группы сюда через «Поделиться», установите новую версию APK." : "";
  const n = allGroups().filter(g => !store.isBlocked(g.key)).length;
  $("groupsCount").textContent = n ? (n > 99 ? "99+" : String(n)) : "";
  if (ui.busy) return;
  const list = visibleResults();
  if (!allGroups().length) {
    $("results").innerHTML = D.manual
      ? '<div class="empty"><b>Список пока пуст</b>Найдите группы по ссылкам выше и добавьте их сюда.</div>'
      : '<div class="empty"><b>Здесь появятся группы</b>Напишите пост, разберите его и нажмите «Найти группы».<br><br><button class="ghost" data-goto="post">К посту</button></div>';
    return;
  }
  if (!list.length) {
    $("results").innerHTML = '<div class="empty"><b>Под эти фильтры ничего нет</b>Снимите фильтр «Можно опубликовать» или выберите другую площадку.</div>';
    return;
  }
  $("results").innerHTML = '<h2 class="sec">Группы</h2>' + list.slice(0, ui.shown).map(groupCard).join("") +
    (list.length > ui.shown ? '<button class="ghost more" data-more>Показать ещё ' + Math.min(PAGE, list.length - ui.shown) + " из " + (list.length - ui.shown) + "</button>" : "");
}

const findResult = key => allGroups().find(g => g.key === key);

async function onCardAction(act, key) {
  const g = findResult(key);
  if (!g) return;
  if (act === "open") {
    if (D.text) {
      const ok = await copyText(D.text);
      if (ok) toast("Текст поста скопирован. Вставьте его в группе.");
    }
    openUrl(g.url);
  } else if (act === "done") {
    store.markPosted(g);
    renderResults();
    toast("Отмечено как опубликованное", "Отменить", () => { store.unmarkPosted(g.key); renderResults(); });
  } else if (act === "block") {
    store.block(g);
    renderResults();
    toast("«" + g.title.slice(0, 40) + "» больше не будет показываться", "Отменить", () => { store.unblock(g.key); renderResults(); });
  }
}

/* ---------- history ---------- */
function renderHistory() {
  document.querySelectorAll("[data-hist]").forEach(b => b.classList.toggle("on", b.dataset.hist === ui.hist));
  const list = ui.hist === "posted" ? store.postedList() : store.blockedList();
  if (!list.length) {
    $("history").innerHTML = ui.hist === "posted"
      ? '<div class="empty"><b>Пока пусто</b>Нажимайте «Опубликовал» на карточке группы, и она появится здесь. Так вы не вернётесь в одну группу дважды.</div>'
      : '<div class="empty"><b>Блок пуст</b>Группы, которые вы отправите в блок, перестанут попадаться в поиске. Вернуть их можно здесь.</div>';
    return;
  }
  $("history").innerHTML = list.map(g =>
    '<div class="hrow ' + esc(g.platform) + '"><div class="h-main"><div class="h-title">' + esc(g.title) + '</div><div class="h-sub">' +
      PLAT[g.platform] + ", " + (ui.hist === "posted" ? "опубликовано " + ago(g.at) + (g.count > 1 ? " (раз: " + g.count + ")" : "") : "в блоке с " + new Date(g.at).toLocaleDateString("ru-RU")) +
    "</div></div>" +
    '<button data-hopen="' + esc(g.url) + '">Открыть</button>' +
    (ui.hist === "posted" ? '<button data-hunpost="' + esc(g.key) + '">Убрать</button>' : '<button data-unblock="' + esc(g.key) + '">Вернуть</button>') +
    "</div>").join("");
}

/* ---------- settings ---------- */
function setStatus(id, text, kind) {
  const el = $(id);
  el.textContent = text || "";
  el.className = "status" + (kind ? " " + kind : "");
}

function renderSettings() {
  $("claudeKey").value = S.claudeKey;
  $("model").innerHTML = Object.entries(MODELS).map(([id, label]) => '<option value="' + id + '"' + (S.model === id ? " selected" : "") + ">" + label + "</option>").join("");
  $("tgEnabled").checked = S.tgEnabled;
  $("tgstatToken").value = S.tgstatToken;
  $("fbEnabled").checked = S.fbEnabled;
  $("autoCollect").checked = !!S.autoCollect;
  $("webSearch").checked = !!(S.webSearch && S.claudeKey);
  if (!$("claudeStatus").textContent) setStatus("claudeStatus", S.claudeKey ? "Ключ сохранён." : "Ключ не добавлен — всё работает бесплатно.", S.claudeKey ? "ok" : "");
  renderVk();
  renderTgAcc();
  if (!$("tgStatus").textContent) setStatus("tgStatus", S.tgEnabled ? (S.tgstatToken ? "Включено." : "Добавьте токен TGStat.") : "Выключено.", S.tgEnabled && S.tgstatToken ? "ok" : "");
  $("versionLine").textContent = "Версия " + appVersion() + (isNative() ? ". Приложение обновляется само: новая версия скачивается при запуске и включается после перезапуска." : ". Это браузерная версия, обновления приходят только в APK.");
  renderUpdateStatus();
}

function renderUpdateStatus() {
  const s = updateStatus();
  const text = {
    idle: "", web: "",
    checking: "Проверяю обновления…",
    latest: "У вас последняя версия.",
    downloading: "Скачиваю версию " + s.detail + "…",
    ready: "Версия " + s.detail + " скачана. Перезапустите приложение.",
    error: s.detail,
  }[s.state] || "";
  setStatus("updateStatus", text, s.state === "error" ? "bad" : s.state === "latest" || s.state === "ready" ? "ok" : "");
}

async function saveClaude() {
  const key = $("claudeKey").value.trim();
  store.saveSettings({ model: $("model").value });
  if (!key) { store.saveSettings({ claudeKey: "", webSearch: false }); $("webSearch").checked = false; setStatus("claudeStatus", "Ключ удалён — всё работает бесплатно."); renderAiHint(); if (D.analysis) renderPlatforms(); return; }
  setStatus("claudeStatus", "Проверяю ключ…");
  try {
    await checkKey(key);
    store.saveSettings({ claudeKey: key });
    setStatus("claudeStatus", "Ключ работает и сохранён на телефоне.", "ok");
  } catch (e) { setStatus("claudeStatus", e.message, "bad"); }
  renderAiHint();
}

function renderVk(msg, kind) {
  const inn = vkid.isSignedIn();
  if (msg) setStatus("vkStatus", msg, kind);
  else if (inn && S.vkApiBlocked) setStatus("vkStatus", "Вы вошли" + (vkid.signedInName() ? " как " + vkid.signedInName() : "") + ", но ВК пока не даёт приложению искать группы: это открывается после подтверждения бизнес-аккаунта VK ID. Пока группы ВК ищутся по ссылкам" + (S.claudeKey && S.webSearch ? " или через Claude" : "") + ".", "");
  else setStatus("vkStatus", inn ? "Вы вошли" + (vkid.signedInName() ? " как " + vkid.signedInName() : "") + "." : "Не обязательно. Вход нужен, чтобы приложение само искало группы ВК; без него вы ищете по готовым ссылкам.", inn ? "ok" : "");
  $("vkLogin").hidden = inn;
  $("logoutVk").hidden = !inn;
  const old = isNative() && !vkid.signInSupported();
  $("vkReinstall").hidden = !old || inn;
  $("vkLogin").disabled = old;
}

async function onVkLogin() {
  if (!isNative()) { renderVk("Вход через ВК работает в приложении на телефоне.", "bad"); return; }
  setStatus("vkStatus", "Открываю вход ВКонтакте…");
  try {
    await vkid.signIn();
    store.saveSettings({ vkApiBlocked: false });
    setStatus("vkStatus", "Проверяю вход…");
    try { const name = await vkCheck(vkid.getToken); vkid.setName(name); } catch (_) {}
    renderVk();
    toast("Вход во ВКонтакте выполнен.");
  } catch (e) { renderVk(e.message || String(e), "bad"); }
  if (D.analysis) renderPlatforms();
}

/* ---------- Telegram account ---------- */
const tgLogin = { pending: null }; // resolves the code / password the user types

function tgStep(step) {
  $("tgPhoneStep").hidden = step !== "phone";
  $("tgCodeStep").hidden = step !== "code";
  $("tgPassStep").hidden = step !== "pass";
}

function renderTgAcc(msg, kind) {
  const inn = tg.isSignedIn();
  $("tgLoginForm").hidden = inn || !tg.tgConfigured();
  $("tgLogout").hidden = !inn;
  if (msg) setStatus("tgAccStatus", msg, kind);
  else if (!tg.tgConfigured()) setStatus("tgAccStatus", "Вход в Telegram появится в ближайшем обновлении.");
  else if (inn) setStatus("tgAccStatus", "Вы вошли" + (tg.signedInName() ? " как " + tg.signedInName() : "") + ". Чаты и каналы ищутся автоматически.", "ok");
  else if (!tgLogin.pending) { setStatus("tgAccStatus", "Не подключено."); tgStep("phone"); }
}

function waitFor(step) {
  tgStep(step);
  return new Promise(resolve => { tgLogin.pending = resolve; });
}

async function onTgSendCode() {
  const phone = $("tgPhone").value.replace(/[^\d+]/g, "");
  if (phone.replace(/\D/g, "").length < 9) { renderTgAcc("Введите номер с кодом страны, например +995 5xx xxx xxx.", "bad"); return; }
  $("tgSendCode").disabled = true;
  setStatus("tgAccStatus", "Подключаюсь к Telegram…");
  let asked = false;
  try {
    const name = await tg.signIn({
      phone,
      askCode: () => {
        if (!asked) setStatus("tgAccStatus", "Код отправлен в Telegram. Введите его ниже.");
        asked = true;
        $("tgCode").value = "";
        return waitFor("code");
      },
      askPassword: hint => { $("tgPassHint").textContent = hint ? "Подсказка: " + hint : ""; setStatus("tgAccStatus", "У вас включён облачный пароль. Введите его."); $("tgPass").value = ""; return waitFor("pass"); },
      onError: msg => setStatus("tgAccStatus", msg, "bad"),
    });
    tgLogin.pending = null;
    renderTgAcc("Вы вошли" + (name ? " как " + name : "") + ". Чаты и каналы ищутся автоматически.", "ok");
    if (D.analysis) renderPlatforms();
  } catch (e) {
    tgLogin.pending = null;
    tgStep("phone");
    renderTgAcc(e.message || String(e), "bad");
  } finally { $("tgSendCode").disabled = false; }
}

function submitTgAnswer(inputId) {
  const v = $(inputId).value.trim();
  if (!v || !tgLogin.pending) return;
  const r = tgLogin.pending; tgLogin.pending = null;
  setStatus("tgAccStatus", "Проверяю…");
  r(v);
}

async function saveTg() {
  const enabled = $("tgEnabled").checked;
  const token = $("tgstatToken").value.trim();
  store.saveSettings({ tgEnabled: enabled, tgstatToken: token });
  if (!enabled) { setStatus("tgStatus", "Выключено."); }
  else if (!token) { setStatus("tgStatus", "Добавьте токен TGStat.", "bad"); }
  else {
    setStatus("tgStatus", "Проверяю токен…");
    try {
      const r = await tgCheck(token);
      const left = Array.isArray(r) ? r.map(x => (x.title || x.serviceKey || "") + ": " + (x.spentRequests != null ? "использовано " + x.spentRequests : "")).filter(Boolean).join("; ") : "";
      setStatus("tgStatus", "Токен работает." + (left ? " " + left : ""), "ok");
    } catch (e) { setStatus("tgStatus", e.message, "bad"); }
  }
  if (D.analysis) renderPlatforms();
}

/* ---------- wiring ---------- */
function wire() {
  document.querySelectorAll(".tabs button").forEach(b => b.addEventListener("click", () => showTab(b.dataset.tab)));
  $("analyzeBtn").addEventListener("click", onAnalyze);
  $("searchBtn").addEventListener("click", onSearch);
  ["postText", "city", "audience"].forEach(id => $(id).addEventListener("change", () => {
    store.saveDraft({ text: $("postText").value.trim(), city: $("city").value.trim(), audience: $("audience").value.trim() });
  }));
  $("addQueryForm").addEventListener("submit", e => {
    e.preventDefault();
    const q = $("newQuery").value.trim();
    if (!q) return;
    if (!D.queries.some(x => x.toLowerCase() === q.toLowerCase())) store.saveDraft({ queries: D.queries.concat([q]) });
    $("newQuery").value = "";
    renderAnalysis();
  });

  document.body.addEventListener("click", e => {
    const t = e.target.closest("button, [data-expand]");
    if (!t) return;
    if (t.dataset.goto) { showTab(t.dataset.goto); return; }
    if (t.dataset.sn) { const q = (D.manual && D.manual.queries[+t.dataset.sq]) || ""; openUrl(SEARCH[t.dataset.sn].url(q)); return; }
    if (t.dataset.open) { openUrl(t.dataset.open); return; }
    if (t.dataset.rmq != null) { const q = D.queries.slice(); q.splice(+t.dataset.rmq, 1); store.saveDraft({ queries: q }); renderAnalysis(); return; }
    if (t.dataset.pf) { ui.platform = t.dataset.pf; ui.shown = PAGE; renderResults(); return; }
    if (t.dataset.flt === "postable") { ui.onlyPostable = !ui.onlyPostable; store.saveSettings({ onlyPostable: ui.onlyPostable }); ui.shown = PAGE; renderResults(); return; }
    if (t.dataset.flt === "forbidden") { ui.hideForbidden = !ui.hideForbidden; store.saveSettings({ hideForbidden: ui.hideForbidden }); ui.shown = PAGE; renderResults(); return; }
    if (t.dataset.more != null) { ui.shown += PAGE; renderResults(); return; }
    if (t.dataset.act) { const card = t.closest("[data-key]"); if (card) onCardAction(t.dataset.act, card.dataset.key); return; }
    if (t.hasAttribute("data-expand")) { t.classList.toggle("open"); return; }
    if (t.dataset.hist) { ui.hist = t.dataset.hist; renderHistory(); return; }
    if (t.dataset.hopen) { openUrl(t.dataset.hopen); return; }
    if (t.dataset.hunpost) { store.unmarkPosted(t.dataset.hunpost); renderHistory(); return; }
    if (t.dataset.unblock) { store.unblock(t.dataset.unblock); renderHistory(); toast("Группа снова будет попадаться в поиске."); return; }
  });

  $("addLinkForm").addEventListener("submit", e => {
    e.preventDefault();
    const v = $("newLink").value.trim();
    if (!v) return;
    $("newLink").value = "";
    addGroupFromText(v, "");
  });
  $("webSearch").addEventListener("change", () => {
    if ($("webSearch").checked && !S.claudeKey) { $("webSearch").checked = false; setStatus("claudeStatus", "Сначала добавьте ключ Claude.", "bad"); return; }
    store.saveSettings({ webSearch: $("webSearch").checked });
    if (D.analysis) renderPlatforms();
  });
  onShared((text, subject) => addGroupFromText(text, subject));
  $("saveClaude").addEventListener("click", saveClaude);
  $("model").addEventListener("change", () => store.saveSettings({ model: $("model").value }));
  $("getClaudeKey").addEventListener("click", () => openUrl("https://console.anthropic.com/settings/keys"));
  $("vkLogin").addEventListener("click", onVkLogin);
  $("logoutVk").addEventListener("click", () => { vkid.signOut(); renderVk("Вы вышли из ВКонтакте."); if (D.analysis) renderPlatforms(); });
  $("saveTg").addEventListener("click", saveTg);
  $("tgSendCode").addEventListener("click", onTgSendCode);
  $("tgSubmitCode").addEventListener("click", () => submitTgAnswer("tgCode"));
  $("tgSubmitPass").addEventListener("click", () => submitTgAnswer("tgPass"));
  $("tgLogout").addEventListener("click", async () => { await tg.signOut(); renderTgAcc("Вы вышли из Telegram."); tgStep("phone"); if (D.analysis) renderPlatforms(); });
  $("tgEnabled").addEventListener("change", saveTg);
  $("getTg").addEventListener("click", () => openUrl("https://api.tgstat.ru/"));
  $("autoCollect").addEventListener("change", () => { store.saveSettings({ autoCollect: $("autoCollect").checked }); if (D.analysis) renderPlatforms(); });
  $("fbEnabled").addEventListener("change", () => { store.saveSettings({ fbEnabled: $("fbEnabled").checked }); if (D.analysis) renderPlatforms(); });
  $("checkUpdates").addEventListener("click", async () => {
    setStatus("updateStatus", "Проверяю обновления…");
    await checkForUpdates();
    renderUpdateStatus();
    if (!isNative()) setStatus("updateStatus", "Обновления проверяются в приложении на телефоне.");
  });
  $("applyUpdate").addEventListener("click", () => applyUpdateNow());
}

function init() {
  $("postText").value = D.text || "";
  $("city").value = D.city || "";
  $("audience").value = D.audience || "";
  renderAiHint();
  renderAnalysis();
  renderResults();
  wire();
  vkid.initVkId();
  initUpdates(() => { $("updateBanner").hidden = false; if (ui.tab === "settings") renderUpdateStatus(); });
}

init();
