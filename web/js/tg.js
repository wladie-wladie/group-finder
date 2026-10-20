// Telegram through the official client API (the same one Telegram apps use), signed in with the
// user's own account. Finds public chats and channels with Telegram's global search — free.
import * as store from "./store.js";

// Developer key of "Где разместить" from my.telegram.org (identifies the app, not the user).
export const TG_API_ID = 0;
export const TG_API_HASH = "";
export const tgConfigured = () => !!(TG_API_ID && TG_API_HASH);

export class TgError extends Error {}

let gramLoading = null;
function loadGram() {
  if (window.GramJS) return Promise.resolve(window.GramJS);
  if (!gramLoading) {
    gramLoading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "js/gram.js";
      s.onload = () => (window.GramJS ? resolve(window.GramJS) : reject(new TgError("Модуль Telegram не загрузился.")));
      s.onerror = () => { gramLoading = null; reject(new TgError("Модуль Telegram не загрузился.")); };
      document.head.appendChild(s);
    });
  }
  return gramLoading;
}

let client = null;
async function getClient() {
  if (!tgConfigured()) throw new TgError("Вход в Telegram ещё не настроен в этой версии приложения.");
  const { TelegramClient, StringSession } = await loadGram();
  if (!client) {
    client = new TelegramClient(new StringSession(store.settings.tgSession || ""), TG_API_ID, TG_API_HASH, {
      connectionRetries: 3,
      useWSS: true,
      deviceModel: "Android",
      systemVersion: "Android",
      appVersion: "Где разместить",
      langCode: "ru",
      systemLangCode: "ru",
    });
    client.setLogLevel("error");
  }
  if (!client.connected) {
    await client.connect();
    if (!client.connected) throw new TgError("Не удалось подключиться к Telegram. Проверьте интернет.");
  }
  return client;
}

export const isSignedIn = () => !!store.settings.tgSession;
export const signedInName = () => store.settings.tgName || "";

const human = e => {
  const m = String((e && (e.errorMessage || e.message)) || e || "");
  if (/PHONE_NUMBER_INVALID/.test(m)) return "Неверный номер телефона. Введите его с кодом страны, например +995…";
  if (/PHONE_CODE_INVALID/.test(m)) return "Неверный код. Проверьте сообщение от Telegram.";
  if (/PHONE_CODE_EXPIRED/.test(m)) return "Код устарел. Запросите новый.";
  if (/PASSWORD_HASH_INVALID/.test(m)) return "Неверный облачный пароль.";
  if (/FLOOD|wait of (\d+)/i.test(m)) { const s = (m.match(/(\d+)/) || [])[1]; return "Telegram просит подождать" + (s ? " " + Math.ceil(s / 60) + " мин." : ".") ; }
  if (/API_ID_INVALID/.test(m)) return "Ключ приложения Telegram не подходит.";
  return "Telegram: " + m;
};

/* ---------- sign-in ---------- */
// The UI supplies three async callbacks; GramJS calls them as the sign-in progresses.
// askCode and askPassword may be called again after a wrong answer (onError shows why).
export async function signIn({ phone, askCode, askPassword, onError }) {
  const c = await getClient();
  try {
    await c.start({
      phoneNumber: async () => phone,
      phoneCode: async () => askCode(),
      password: async hint => askPassword(hint),
      onError: async err => {
        const msg = human(err);
        onError(msg);
        // Stop on errors the user cannot fix by retyping.
        return /FLOOD|PHONE_NUMBER_INVALID|API_ID|подождать|номер/i.test(String(err && (err.errorMessage || err.message)) + msg);
      },
    });
  } catch (e) { throw new TgError(human(e)); }
  const me = await c.getMe();
  const name = [me.firstName, me.lastName].filter(Boolean).join(" ") || (me.username ? "@" + me.username : "");
  store.saveSettings({ tgSession: c.session.save(), tgName: name });
  return name;
}

export async function signOut() {
  try { if (client) { await client.invoke(new window.GramJS.Api.auth.LogOut()); await client.disconnect(); } } catch (_) {}
  client = null;
  store.saveSettings({ tgSession: "", tgName: "" });
}

/* ---------- search ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function tgAccountSearch(queries, onProgress) {
  const c = await getClient();
  const { Api } = window.GramJS;
  const out = new Map();
  for (let i = 0; i < queries.length; i++) {
    let res = null;
    for (let attempt = 0; attempt < 2 && !res; attempt++) {
      try {
        res = await c.invoke(new Api.contacts.Search({ q: queries[i], limit: 50 }));
      } catch (e) {
        const wait = Number(e && e.seconds) || 0;
        if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|USER_DEACTIVATED/.test(String(e && e.errorMessage))) {
          store.saveSettings({ tgSession: "", tgName: "" });
          client = null;
          throw new TgError("Вход в Telegram сброшен. Войдите заново в настройках.");
        }
        if (wait && wait <= 30 && attempt === 0) { await sleep(wait * 1000 + 500); continue; }
        if (wait) throw new TgError("Telegram просит сделать паузу на " + Math.ceil(wait / 60) + " мин. Найденное показано.");
        throw new TgError(human(e));
      }
    }
    ((res && res.chats) || []).forEach(ch => {
      if (ch.className !== "Channel") return;
      const username = ch.username || (ch.usernames && ch.usernames[0] && ch.usernames[0].username);
      if (!username) return; // private: no public link
      const key = "tg:" + username.toLowerCase();
      const ex = out.get(key);
      if (ex) { ex.queries.push(queries[i]); return; }
      const isChat = !!ch.megagroup || !!ch.gigagroup;
      out.set(key, {
        key,
        platform: "tg",
        title: ch.title || "@" + username,
        url: "https://t.me/" + username,
        members: Number(ch.participantsCount) || 0,
        description: "",
        tgType: isChat ? "chat" : "channel",
        canPost: isChat,
        canSuggest: false,
        closed: false,
        queries: [queries[i]],
      });
    });
    onProgress && onProgress(i + 1, queries.length);
    if (i + 1 < queries.length) await sleep(1100);
  }
  return [...out.values()];
}
