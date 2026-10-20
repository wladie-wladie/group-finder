// VK ID sign-in (OAuth 2.1 with PKCE), the same flow VK's own Android SDK uses:
// open id.vk.ru in a browser tab → VK returns to vk<app id>://vk.ru/blank.html?code=…&device_id=…
// → the app exchanges the code for tokens and refreshes them when they expire.
import * as store from "./store.js";

export const VK_APP_ID = "54838220";
const REDIRECT = "vk" + VK_APP_ID + "://vk.ru/blank.html";
const ID_HOST = "https://id.vk.ru";
const SCOPES = "groups";

const cap = () => window.Capacitor;
const available = name => !!(cap() && cap().isPluginAvailable && cap().isPluginAvailable(name));
const plugins = {};
const plugin = name => (plugins[name] = plugins[name] || cap().registerPlugin(name));

export class VkAuthError extends Error {}

// The sign-in needs the App and Browser modules, which came with APK 1.0.2.
// An older APK that received this screen as an update has to be reinstalled.
export const signInSupported = () => available("App") && available("Browser");

/* ---------- PKCE helpers ---------- */
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function randomString(len) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, b => chars[b % chars.length]).join("");
}
async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

/* ---------- token storage ---------- */
// settings.vkAuth = { access, refresh, deviceId, expiresAt, userId, name }
const auth = () => store.settings.vkAuth || null;
export const isSignedIn = () => !!(auth() && auth().access);
export const signedInName = () => (auth() && auth().name) || "";

function saveTokens(r, deviceId, prev) {
  const a = {
    access: r.access_token,
    refresh: r.refresh_token || (prev && prev.refresh) || "",
    deviceId: deviceId || (prev && prev.deviceId) || "",
    expiresAt: Date.now() + (Number(r.expires_in) || 3600) * 1000,
    userId: r.user_id || (prev && prev.userId) || null,
    name: (prev && prev.name) || "",
  };
  store.saveSettings({ vkAuth: a });
  return a;
}

async function postForm(path, fields) {
  let res, data;
  try {
    res = await fetch(ID_HOST + path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });
    data = await res.json();
  } catch (_) { throw new VkAuthError("Нет связи с VK ID. Проверьте интернет."); }
  if (!data || data.error || !data.access_token) {
    const d = (data && (data.error_description || data.error)) || "ошибка " + (res && res.status);
    throw new VkAuthError("VK ID: " + d);
  }
  return data;
}

/* ---------- sign-in ---------- */
let pending = null; // { resolve, reject }
let listening = false;

function listen() {
  if (listening) return;
  listening = true;
  plugin("App").addListener("appUrlOpen", ev => { handleReturn(ev && ev.url); });
}

async function handleReturn(url) {
  if (!url || !url.startsWith("vk" + VK_APP_ID + "://")) return;
  try { await plugin("Browser").close(); } catch (_) {}
  const p = pending; pending = null;
  const fail = msg => { if (p) p.reject(new VkAuthError(msg)); };
  let q;
  try { q = new URL(url.replace(/^vk\d+:\/\//, "https://")).searchParams; } catch (_) { return fail("ВК вернул непонятный ответ."); }
  // VK may pack the result into a "payload" JSON parameter.
  if (q.get("payload")) {
    try { const pl = JSON.parse(q.get("payload")); Object.keys(pl).forEach(k => q.set(k, pl[k])); } catch (_) {}
  }
  if (q.get("error")) return fail("ВК не дал войти: " + (q.get("error_description") || q.get("error")));
  const code = q.get("code"), deviceId = q.get("device_id"), state = q.get("state");
  const saved = JSON.parse(localStorage.getItem("gf:vkPkce") || "null");
  localStorage.removeItem("gf:vkPkce");
  if (!code || !deviceId) return fail("ВК не вернул код входа. Попробуйте ещё раз.");
  if (!saved || saved.state !== state) return fail("Вход устарел. Нажмите «Войти через ВК» ещё раз.");
  try {
    const r = await postForm("/oauth2/auth", {
      grant_type: "authorization_code",
      code,
      code_verifier: saved.verifier,
      client_id: VK_APP_ID,
      device_id: deviceId,
      redirect_uri: REDIRECT,
      state,
    });
    const a = saveTokens(r, deviceId, null);
    p && p.resolve(a);
  } catch (e) { if (p) p.reject(e); }
}

// Opens VK sign-in; resolves when the user comes back signed in.
export async function signIn() {
  if (!signInSupported()) throw new VkAuthError("Для входа через ВК установите новую версию APK.");
  listen();
  const verifier = randomString(64);
  const state = randomString(32);
  localStorage.setItem("gf:vkPkce", JSON.stringify({ verifier, state, at: Date.now() }));
  const p = new URLSearchParams({
    client_id: VK_APP_ID,
    response_type: "code",
    redirect_uri: REDIRECT,
    code_challenge: await challengeFor(verifier),
    code_challenge_method: "s256",
    state,
    scope: SCOPES,
    lang_id: "0",
  });
  const done = new Promise((resolve, reject) => { pending = { resolve, reject }; });
  await plugin("Browser").open({ url: ID_HOST + "/authorize?" + p.toString() });
  return done;
}

// Call at start-up so a return from VK is caught even if Android restarted the app meanwhile.
export function initVkId() {
  if (!signInSupported()) return;
  listen();
  plugin("App").getLaunchUrl().then(r => { if (r && r.url) handleReturn(r.url); }).catch(() => {});
}

export function signOut() {
  const a = auth();
  store.saveSettings({ vkAuth: null });
  if (a && a.access) {
    fetch(ID_HOST + "/oauth2/logout", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: VK_APP_ID, access_token: a.access, device_id: a.deviceId }).toString(),
    }).catch(() => {});
  }
}

export function setName(name) {
  const a = auth();
  if (a) store.saveSettings({ vkAuth: Object.assign({}, a, { name }) });
}

// A working access token, refreshed when it is about to expire (force = refresh now).
export async function getToken(force) {
  const a = auth();
  if (!a || !a.access) throw new VkAuthError("Войдите во ВКонтакте в настройках.");
  if (!force && a.expiresAt - Date.now() > 60000) return a.access;
  if (!a.refresh) throw new VkAuthError("Вход во ВКонтакте истёк. Войдите заново в настройках.");
  try {
    const r = await postForm("/oauth2/auth", {
      grant_type: "refresh_token",
      refresh_token: a.refresh,
      client_id: VK_APP_ID,
      device_id: a.deviceId,
      state: randomString(32),
    });
    return saveTokens(r, a.deviceId, a).access;
  } catch (e) {
    throw new VkAuthError("Вход во ВКонтакте истёк. Войдите заново в настройках.");
  }
}
