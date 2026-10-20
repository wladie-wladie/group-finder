// Free mode: ready search links per query, and turning a shared or pasted link into a group card.

export const SEARCH = {
  vk: { label: "ВК", url: q => "https://vk.com/search/communities?q=" + encodeURIComponent(q) },
  tg: { label: "Telegram", url: q => "https://tgstat.ru/channels/search?q=" + encodeURIComponent(q) },
  fb: { label: "Facebook", url: q => "https://www.facebook.com/search/groups/?q=" + encodeURIComponent(q) },
};

// Finds the first group link in shared text ("Название https://vk.com/xxx", a post link, etc.).
export function parseGroupLink(text) {
  const urls = String(text || "").match(/(https?:\/\/)?(www\.|m\.)?(vk\.com|vk\.ru|vkontakte\.ru|t\.me|telegram\.me|facebook\.com|fb\.com)\/[^\s<>"')]+/gi) || [];
  for (const raw of urls) {
    let u;
    try { u = new URL(/^https?:/i.test(raw) ? raw : "https://" + raw); } catch (_) { continue; }
    const host = u.hostname.replace(/^(www|m)\./, "").toLowerCase();
    const parts = u.pathname.split("/").filter(Boolean);
    if (!parts.length) continue;
    if (/^(vk\.com|vk\.ru|vkontakte\.ru)$/.test(host)) {
      let slug = parts[0];
      const wall = slug.match(/^wall-(\d+)_/) || (u.searchParams.get("w") || "").match(/^wall-(\d+)_/);
      if (wall) slug = "club" + wall[1];
      if (/^(search|feed|im|away\.php|video|photo|audio|music|friends|groups|login|share\.php|app\d*|market)$/i.test(slug)) continue;
      if (/^(public|event)\d+$/.test(slug)) slug = "club" + slug.replace(/\D/g, "");
      return { platform: "vk", slug: slug.toLowerCase(), url: "https://vk.com/" + slug };
    }
    if (host === "t.me" || host === "telegram.me") {
      let slug = parts[0];
      if (slug === "s" && parts[1]) slug = parts[1];
      if (/^(share|addstickers|addemoji|proxy|socks)$/i.test(slug)) continue;
      if (slug === "joinchat" && parts[1]) slug = "+" + parts[1];
      return { platform: "tg", slug, url: "https://t.me/" + slug };
    }
    if (host === "facebook.com" || host === "fb.com") {
      if (parts[0] !== "groups" || !parts[1]) continue;
      return { platform: "fb", slug: parts[1].toLowerCase(), url: "https://www.facebook.com/groups/" + parts[1] };
    }
  }
  return null;
}

// Card for a group the user added by hand.
export function manualGroup(link, titleHint) {
  const fallback = link.platform === "tg" ? "@" + link.slug.replace(/^\+/, "") : link.slug;
  return {
    key: link.platform + ":" + link.slug,
    platform: link.platform,
    title: cleanTitle(titleHint) || fallback,
    url: link.url,
    members: 0,
    description: "",
    manual: true,
    canPost: false,
    canSuggest: false,
    closed: false,
    queries: [],
    addedAt: Date.now(),
  };
}

function cleanTitle(s) {
  s = String(s || "").replace(/(https?:\/\/)?\S+\.(com|ru|me)\/\S*/gi, "").replace(/\s+/g, " ").trim();
  return s.length >= 2 && s.length <= 120 ? s : "";
}

const decode = s => String(s || "")
  .replace(/&quot;/g, '"').replace(/&#39;|&#039;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).trim();
const meta = (html, prop) => {
  const m = html.match(new RegExp('<meta[^>]+(?:property|name)="' + prop + '"[^>]+content="([^"]*)"', "i")) ||
    html.match(new RegExp('<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="' + prop + '"', "i"));
  return m ? decode(m[1]) : "";
};
function membersFrom(text) {
  const m = String(text).match(/([\d][\d\s .,]*)\s*(тыс\.?|K)?\s*(участник|подписчик|member|subscriber|follower)/i);
  if (!m) return 0;
  let n = parseFloat(m[1].replace(/[\s ]/g, "").replace(",", "."));
  if (m[2]) n *= 1000;
  return Math.round(n) || 0;
}

// Best effort: fills title, description and members from the public page. Works in the APK
// (requests go through the native layer); in a desktop browser it quietly does nothing.
export async function fetchMeta(g) {
  if (g.platform === "fb") return g;
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 8000) : null;
  try {
    const res = await fetch(g.url, { signal: ctrl && ctrl.signal, headers: { "accept-language": "ru,en;q=0.8" } });
    if (!res.ok) return g;
    const html = await res.text();
    const title = meta(html, "og:title") || ((html.match(/<title>([^<]*)<\/title>/i) || [])[1] || "");
    const desc = meta(html, "og:description") || meta(html, "description");
    if (g.platform === "tg") {
      const extra = decode(((html.match(/class="tgme_page_extra"[^>]*>([^<]*)</) || [])[1]) || "");
      if (extra) {
        g.members = membersFrom(extra) || g.members;
        g.tgType = /member|участник/i.test(extra) ? "chat" : "channel";
      }
    } else {
      g.members = membersFrom(desc) || membersFrom(html.slice(0, 200000)) || g.members;
    }
    const t = decode(title).replace(/\s*\|\s*(ВКонтакте|VK)\s*$/i, "").replace(/^Telegram:\s*(Contact|View)\s*/i, "");
    if (t && !/^(VK|ВКонтакте|Telegram|Вход|Log in)/i.test(t)) g.title = t.slice(0, 120);
    if (desc && !/^(ВКонтакте|VK) — /i.test(desc)) g.description = desc.slice(0, 500);
  } catch (_) {
    // offline, blocked or CORS in a browser: keep what we have
  } finally { if (timer) clearTimeout(timer); }
  return g;
}
