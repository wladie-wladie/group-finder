// Finding groups through Claude's web search (needs only the Claude API key).
// Used for VKontakte when the VK API is not available for the sign-in,
// for Telegram without TGStat, and for real Facebook groups instead of search links.
import { AiError } from "./ai.js";

const API = "https://api.anthropic.com/v1/messages";
const headers = key => ({
  "x-api-key": key,
  "anthropic-version": "2023-06-01",
  "content-type": "application/json",
  "anthropic-dangerous-direct-browser-access": "true",
});

const PLATFORMS = {
  vk: { name: "ВКонтакте", domains: ["vk.com", "vk.ru"], hint: "группы и сообщества ВКонтакте (ссылки вида vk.com/имя_группы или vk.com/club123)" },
  tg: { name: "Telegram", domains: ["t.me", "tgstat.ru", "telemetr.io"], hint: "Telegram-чаты и каналы (ссылки t.me/имя; если нашёл карточку на tgstat.ru или telemetr.io — переведи её в ссылку t.me/имя)" },
  fb: { name: "Facebook", domains: ["facebook.com"], hint: "группы Facebook (ссылки facebook.com/groups/…)" },
};

// Normalises a link to compare it with search result URLs: host without www/m, path without trailing slash.
function norm(u) {
  try {
    const x = new URL(u);
    const host = x.hostname.replace(/^(www|m)\./, "").replace(/^vk\.ru$/, "vk.com");
    return (host + x.pathname.replace(/\/+$/, "")).toLowerCase();
  } catch (_) { return ""; }
}

function groupUrlOk(platform, url) {
  const n = norm(url);
  if (platform === "vk") return /^vk\.com\/(?!search|feed|wall|video|photo|topic|away|im|share|doc|app|market\b)[a-z0-9_.]+$/.test(n);
  if (platform === "tg") return /^t\.me\/(?!s\/|share|addstickers|joinchat\/?$)[a-z0-9_+/-]+$/.test(n);
  if (platform === "fb") return /^facebook\.com\/groups\/[^/]+$/.test(n);
  return false;
}

async function callClaude(key, body) {
  let res, data;
  try {
    res = await fetch(API, { method: "POST", headers: headers(key), body: JSON.stringify(body) });
    data = await res.json();
  } catch (_) { throw new AiError("Нет связи с Claude. Проверьте интернет."); }
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || "";
    if (res.status === 401) throw new AiError("Ключ Claude не подходит.");
    if (/credit balance/i.test(msg)) throw new AiError("На балансе Claude API закончились деньги.");
    if (/web.?search/i.test(msg)) throw new AiError("Веб-поиск не включён для вашего ключа. Включите его в консоли Anthropic (Settings → Privacy / Web search).");
    throw new AiError(msg ? "Ошибка Claude: " + msg : "Claude не ответил.");
  }
  return data;
}

// Returns groups in the same shape as sources.js. Only links that actually appeared
// in the search results (or in their citations) are kept, so nothing is made up.
export async function webSearchGroups({ key, model, platform, queries, summary, city }) {
  const p = PLATFORMS[platform];
  const prompt = `Найди через веб-поиск реальные ${p.hint}, где уместно разместить пост об услуге.
Суть услуги: ${summary || "см. запросы"}
${city ? "Город или регион: " + city + "\n" : ""}Поисковые запросы, от которых стоит оттолкнуться: ${queries.slice(0, 12).join("; ")}.

Сделай несколько поисков (по одному-двум запросам за раз), ищи именно открытые сообщества: тематические, городские, соседские, доски объявлений, барахолки.
Ответь ТОЛЬКО JSON без пояснений:
{"groups":[{"title":"название","url":"полная ссылка на сообщество","members":12000,"about":"коротко, о чём сообщество и что сказано про рекламу или объявления, если видно"}]}
members — число участников, если оно видно в результатах, иначе null. Только сообщества с прямой ссылкой из результатов поиска, без выдуманных. До 25 штук.`;

  const messages = [{ role: "user", content: prompt }];
  const seenUrls = new Set();
  let finalText = "";
  for (let turn = 0; turn < 4; turn++) {
    const data = await callClaude(key, {
      model,
      max_tokens: 4000,
      messages,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6, allowed_domains: p.domains }],
    });
    (data.content || []).forEach(b => {
      if (b.type === "web_search_tool_result" && Array.isArray(b.content)) b.content.forEach(r => r.url && seenUrls.add(norm(r.url)));
      if (b.type === "text") {
        finalText += b.text;
        (b.citations || []).forEach(c => c.url && seenUrls.add(norm(c.url)));
      }
    });
    if (data.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: data.content });
    finalText = "";
  }

  const m = finalText.match(/\{[\s\S]*\}/);
  let list = [];
  try { list = (JSON.parse(m ? m[0] : "{}").groups) || []; } catch (_) { list = []; }
  const out = new Map();
  list.forEach(g => {
    let url = String(g.url || "").trim();
    if (!url) return;
    if (!/^https?:/.test(url)) url = "https://" + url.replace(/^\/+/, "");
    url = url.replace(/^https?:\/\/(www\.|m\.)?vk\.ru\//, "https://vk.com/").replace(/^https?:\/\/(www\.|m\.)/, "https://");
    if (!groupUrlOk(platform, url)) return;
    const n = norm(url);
    // The link itself, or a page inside it (a post, a tgstat card) must have been in the results.
    const fromResults = seenUrls.has(n) || [...seenUrls].some(s => s.startsWith(n + "/")) ||
      (platform === "tg" && [...seenUrls].some(s => /tgstat\.ru|telemetr\.io/.test(s) && s.includes(n.split("/")[1])));
    if (!fromResults) return;
    if (out.has(n)) return;
    const isChat = platform === "tg" && /чат|chat|барахолк|объявлен/i.test((g.title || "") + " " + (g.about || ""));
    out.set(n, {
      key: platform + ":" + n.split("/").slice(1).join("/"),
      platform,
      title: String(g.title || n).slice(0, 120),
      url,
      members: Number(g.members) || 0,
      description: String(g.about || ""),
      viaWeb: true,
      tgType: platform === "tg" ? (isChat ? "chat" : "channel") : undefined,
      canPost: false,
      canSuggest: false,
      closed: false,
      queries: [],
    });
  });
  return [...out.values()];
}

export const webSearchCostNote = "Каждый поиск через Claude стоит около $0,01 плюс токены — обычно 3–8 центов на площадку.";
