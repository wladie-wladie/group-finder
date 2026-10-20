// Everything is stored on the phone (localStorage). The app has no server of its own.
const KEY = "gf:";

function load(name, fallback) {
  try {
    const raw = localStorage.getItem(KEY + name);
    return raw ? JSON.parse(raw) : fallback;
  } catch (_) { return fallback; }
}
function save(name, value) {
  try { localStorage.setItem(KEY + name, JSON.stringify(value)); } catch (_) {}
}

const DEFAULT_SETTINGS = {
  claudeKey: "",
  model: "claude-sonnet-5-5",
  vkAuth: null,
  tgEnabled: false,
  tgstatToken: "",
  fbEnabled: true,
  webSearch: false,
  autoCollect: false, // hidden-browser collection on VK/Facebook: off, both networks ended sessions
  onlyPostable: true,
  hideForbidden: false,
};

export const settings = Object.assign({}, DEFAULT_SETTINGS, load("settings", {}));
export function saveSettings(patch) {
  Object.assign(settings, patch);
  save("settings", settings);
}

// Groups are identified as "<platform>:<id>", e.g. "vk:123456", "tg:@channel".
const blocked = load("blocked", {});
const saved = load("saved", []);  // groups the user added by hand or shared into the app

export const savedList = () => saved.slice();
export function addSaved(g) {
  const i = saved.findIndex(x => x.key === g.key);
  if (i >= 0) return false;
  saved.unshift(g);
  save("saved", saved);
  return true;
}
export function updateSaved(key, patch) {
  const g = saved.find(x => x.key === key);
  if (g) { Object.assign(g, patch); save("saved", saved); }
}
export function removeSaved(key) {
  const i = saved.findIndex(x => x.key === key);
  if (i >= 0) { saved.splice(i, 1); save("saved", saved); }
}
const posted = load("posted", {});

export const isBlocked = key => !!blocked[key];
export const blockedList = () => Object.entries(blocked).map(([key, g]) => Object.assign({ key }, g)).sort((a, b) => b.at - a.at);
export function block(g) {
  blocked[g.key] = { title: g.title, url: g.url, platform: g.platform, at: Date.now() };
  save("blocked", blocked);
  removeSaved(g.key);
}
export function unblock(key) { delete blocked[key]; save("blocked", blocked); }

export const postedAt = key => (posted[key] ? posted[key].at : null);
export const postedList = () => Object.entries(posted).map(([key, g]) => Object.assign({ key }, g)).sort((a, b) => b.at - a.at);
export function markPosted(g) {
  posted[g.key] = { title: g.title, url: g.url, platform: g.platform, at: Date.now(), count: ((posted[g.key] && posted[g.key].count) || 0) + 1 };
  save("posted", posted);
}
export function unmarkPosted(key) { delete posted[key]; save("posted", posted); }

// The current draft: post text, analysis, queries and the last results.
export const draft = Object.assign({ text: "", city: "", audience: "", analysis: null, queries: [], results: [] }, load("draft", {}));
export function saveDraft(patch) {
  Object.assign(draft, patch);
  save("draft", draft);
}
