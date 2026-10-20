// Where groups come from: VK API (free, needs a VK sign-in), TGStat API (paid, optional),
// and Facebook search links (Facebook has no public group search API).
const VK_API = "https://api.vk.com/method/";
const VK_V = "5.199";
const sleep = ms => new Promise(r => setTimeout(r, ms));

export class SourceError extends Error {
  constructor(source, message) { super(message); this.source = source; }
}

/* ---------- VK sign-in ---------- */

export function vkAuthUrl(appId) {
  const p = new URLSearchParams({
    client_id: String(appId).trim(),
    display: "mobile",
    redirect_uri: "https://oauth.vk.com/blank.html",
    scope: "groups,offline",
    response_type: "token",
    v: VK_V,
  });
  return "https://oauth.vk.com/authorize?" + p.toString();
}

// Accepts the whole address from the browser after sign-in, or the bare token.
export function parseVkToken(input) {
  const s = String(input || "").trim();
  const m = s.match(/access_token=([^&\s#]+)/);
  if (m) return decodeURIComponent(m[1]);
  if (/^[A-Za-z0-9._-]{40,}$/.test(s)) return s;
  return "";
}

let lastVkCall = 0;
async function vk(method, params, token) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const wait = 360 - (Date.now() - lastVkCall); // VK allows ~3 requests per second
    if (wait > 0) await sleep(wait);
    lastVkCall = Date.now();
    const body = new URLSearchParams(Object.assign({}, params, { access_token: token, v: VK_V }));
    let res, data;
    try {
      res = await fetch(VK_API + method, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
      data = await res.json();
    } catch (_) { throw new SourceError("vk", "Нет связи с ВКонтакте. Проверьте интернет."); }
    if (data && data.error) {
      const c = data.error.error_code;
      if (c === 6 || c === 9) { await sleep(1200); continue; } // too many requests
      if (c === 5) throw new SourceError("vk", "Вход во ВКонтакте устарел. Войдите заново в настройках.");
      if (c === 17) throw new SourceError("vk", "ВКонтакте просит подтвердить вход. Войдите заново в настройках.");
      if (c === 29) throw new SourceError("vk", "ВКонтакте ограничил поиск на сегодня. Попробуйте завтра.");
      throw new SourceError("vk", "ВКонтакте: " + (data.error.error_msg || "ошибка " + c));
    }
    return data.response;
  }
  throw new SourceError("vk", "ВКонтакте просит делать запросы реже. Попробуйте через минуту.");
}

export async function vkCheck(token) {
  const r = await vk("users.get", {}, token);
  const u = r && r[0];
  return u ? (u.first_name + " " + u.last_name).trim() : "";
}

// Returns groups found by all queries, with details (members, whether you can post).
export async function vkSearch(queries, token, onProgress) {
  const byId = new Map();
  for (let i = 0; i < queries.length; i++) {
    const r = await vk("groups.search", { q: queries[i], count: 100 }, token);
    ((r && r.items) || []).forEach(g => {
      const ex = byId.get(g.id);
      if (ex) ex.queries.push(queries[i]);
      else byId.set(g.id, { id: g.id, queries: [queries[i]] });
    });
    onProgress && onProgress(i + 1, queries.length);
  }
  const ids = [...byId.keys()];
  const out = [];
  for (let i = 0; i < ids.length; i += 400) {
    const r = await vk("groups.getById", {
      group_ids: ids.slice(i, i + 400).join(","),
      fields: "members_count,can_post,can_suggest,description,activity,is_closed,status,city",
    }, token);
    const list = Array.isArray(r) ? r : (r && r.groups) || [];
    list.forEach(g => {
      const shortName = g.screen_name || "club" + g.id;
      out.push({
        key: "vk:" + g.id,
        platform: "vk",
        title: g.name || shortName,
        url: "https://vk.com/" + shortName,
        members: g.members_count || 0,
        description: [g.activity, g.status, g.description].filter(Boolean).join(". "),
        city: g.city && g.city.title,
        closed: !!g.is_closed,
        canPost: g.can_post === 1,
        canSuggest: g.can_suggest === 1,
        queries: byId.get(g.id).queries,
      });
    });
  }
  return out;
}

/* ---------- Telegram via TGStat (paid) ---------- */

export async function tgSearch(queries, token, onProgress) {
  const byKey = new Map();
  for (let i = 0; i < queries.length; i++) {
    const p = new URLSearchParams({ token, q: queries[i], peer_type: "all", limit: "50", search_by_description: "1" });
    let data;
    try {
      const res = await fetch("https://api.tgstat.ru/channels/search?" + p.toString());
      data = await res.json();
    } catch (_) { throw new SourceError("tg", "Нет связи с TGStat. Проверьте интернет."); }
    if (!data || data.status !== "ok") {
      const msg = (data && (data.error || data.message)) || "неизвестная ошибка";
      if (/token/i.test(msg)) throw new SourceError("tg", "TGStat не принял токен. Проверьте его в настройках.");
      if (/quota|limit|tariff|subscription/i.test(msg)) throw new SourceError("tg", "Закончился лимит запросов TGStat по вашему тарифу.");
      throw new SourceError("tg", "TGStat: " + msg);
    }
    const items = (data.response && (data.response.items || data.response)) || [];
    (Array.isArray(items) ? items : []).forEach(c => {
      let link = c.link || (c.username ? "t.me/" + String(c.username).replace(/^@/, "") : "");
      if (!link) return;
      if (!/^https?:/.test(link)) link = "https://" + link.replace(/^\/+/, "");
      const key = "tg:" + (c.username || c.id || link);
      const ex = byKey.get(key);
      if (ex) { ex.queries.push(queries[i]); return; }
      const isChat = c.peer_type === "chat";
      byKey.set(key, {
        key,
        platform: "tg",
        title: c.title || c.username || link,
        url: link,
        members: c.participants_count || 0,
        description: c.about || "",
        tgType: isChat ? "chat" : "channel",
        canPost: isChat,          // in a chat members can write; in a channel only admins post
        canSuggest: false,
        closed: false,
        queries: [queries[i]],
      });
    });
    onProgress && onProgress(i + 1, queries.length);
  }
  return [...byKey.values()];
}

export async function tgCheck(token) {
  let data;
  try {
    const res = await fetch("https://api.tgstat.ru/usage/stat?" + new URLSearchParams({ token }).toString());
    data = await res.json();
  } catch (_) { throw new SourceError("tg", "Нет связи с TGStat. Проверьте интернет."); }
  if (!data || data.status !== "ok") throw new SourceError("tg", "TGStat не принял токен: " + ((data && data.error) || "ошибка"));
  return data.response;
}

/* ---------- Facebook: ready search links ---------- */

export function fbLinks(queries) {
  return queries.map(q => ({
    key: "fb:" + q.toLowerCase(),
    platform: "fb",
    title: "Группы Facebook: «" + q + "»",
    url: "https://www.facebook.com/search/groups/?q=" + encodeURIComponent(q),
    members: 0,
    description: "Facebook не даёт искать группы через API, поэтому здесь готовый поиск. Откройте и выберите открытые группы.",
    isSearch: true,
    canPost: false,
    canSuggest: false,
    closed: false,
    queries: [q],
  }));
}
