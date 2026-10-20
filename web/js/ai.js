// Post analysis and group scoring: Claude API with the user's own key,
// or a simple free mode that works without a key.
export const MODELS = {
  "claude-sonnet-5-5": "Точнее (Sonnet)",
  "claude-haiku-5-5": "Дешевле (Haiku)",
};

const API = "https://api.anthropic.com/v1";
const headers = key => ({
  "x-api-key": key,
  "anthropic-version": "2023-06-01",
  "content-type": "application/json",
  "anthropic-dangerous-direct-browser-access": "true",
});

export class AiError extends Error {}

function apiError(status, body) {
  const msg = (body && body.error && body.error.message) || "";
  if (status === 401) return new AiError("Ключ Claude не подходит. Проверьте, что скопировали его целиком.");
  if (status === 403) return new AiError("У ключа Claude нет доступа. Создайте новый ключ в консоли Anthropic.");
  if (/credit balance/i.test(msg)) return new AiError("На балансе Claude API закончились деньги. Пополните его в консоли Anthropic.");
  if (status === 429) return new AiError("Слишком много запросов к Claude. Попробуйте через минуту.");
  if (status >= 500) return new AiError("Сервис Claude сейчас перегружен. Попробуйте через минуту.");
  return new AiError(msg ? "Ошибка Claude: " + msg : "Claude не ответил.");
}

async function ask(key, model, prompt, maxTokens) {
  let res;
  try {
    res = await fetch(API + "/messages", {
      method: "POST",
      headers: headers(key),
      body: JSON.stringify({ model, max_tokens: maxTokens || 2000, messages: [{ role: "user", content: prompt }] }),
    });
  } catch (_) { throw new AiError("Нет связи с Claude. Проверьте интернет."); }
  let body = null;
  try { body = await res.json(); } catch (_) {}
  if (!res.ok) throw apiError(res.status, body);
  const text = ((body && body.content) || []).filter(b => b.type === "text").map(b => b.text).join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new AiError("Claude ответил в непонятном формате. Попробуйте ещё раз.");
  try { return JSON.parse(m[0]); } catch (_) { throw new AiError("Claude ответил в непонятном формате. Попробуйте ещё раз."); }
}

export async function checkKey(key) {
  let res;
  try { res = await fetch(API + "/models?limit=1", { headers: headers(key) }); }
  catch (_) { throw new AiError("Нет связи с Claude. Проверьте интернет."); }
  if (!res.ok) { let b = null; try { b = await res.json(); } catch (_) {} throw apiError(res.status, b); }
  return true;
}

/* ---------- post analysis ---------- */

export async function analyzePost({ key, model, text, city, audience }) {
  if (!key) return analyzeFree({ text, city, audience });
  const prompt = `Ты помогаешь малому бизнесу найти тематические сообщества (группы ВКонтакте, Telegram-каналы и чаты, группы Facebook), где уместно рассказать о своей услуге.

Пост пользователя:
"""
${text.slice(0, 4000)}
"""
${city ? "Город или регион: " + city + "\n" : ""}${audience ? "Пожелания к аудитории: " + audience + "\n" : ""}
Определи суть предложения и кому оно полезно. Затем придумай поисковые запросы для поиска сообществ по названию.
Запросы должны быть короткими (1–3 слова), как названия групп: «ремонт квартир Казань», «барахолка Тбилиси», «мамы Подольска», «новостройки СПб».
Включи и прямые тематические запросы, и запросы про места, где обитает целевая аудитория (районы, ЖК, профессиональные и соседские сообщества, доски объявлений). Если указан город, добавляй его к большинству запросов.

Ответь ТОЛЬКО одним JSON-объектом без пояснений и без markdown:
{"summary":"суть предложения одной фразой","audience":["кому полезно", "..."],"queries":["запрос 1","запрос 2"],"tips":"1–2 коротких совета, как подать этот пост в чужих группах, чтобы его не удалили"}
В queries 8–14 запросов, без повторов.`;
  const r = await ask(key, model, prompt, 1500);
  return {
    summary: String(r.summary || ""),
    audience: Array.isArray(r.audience) ? r.audience.map(String).slice(0, 8) : [],
    queries: uniq((r.queries || []).map(q => String(q).trim()).filter(Boolean)).slice(0, 16),
    tips: String(r.tips || ""),
    mode: "ai",
  };
}

const STOP = new Set(("и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно всю между это наш наши ваш ваши вас нам свой своих очень любой любые также который которые которая это все всё звоните пишите пишите звоните телефон цена цены руб рублей лари недорого скидка скидки акция быстро качественно опыт лет гарантия выезд бесплатно бесплатная наших наша работаем работы услуги услуга предлагаем предлагаю делаем делаю сделаю беру возьму дому опытом опыт ключ смета смету дома доме выезжаю приеду пишите звоните обращайтесь подробнее личку личные сообщения записывайтесь запись").split(" "));

function analyzeFree({ text, city, audience }) {
  const cityStem = (city || "").toLowerCase().trim().slice(0, 5);
  const words = (text.toLowerCase().match(/[a-zа-яёა-ჰ0-9-]{4,}/g) || [])
    .filter(w => !STOP.has(w) && !/^\d+$/.test(w) && !(cityStem.length >= 4 && w.startsWith(cityStem)));
  const freq = {};
  words
    .filter(w => !/(аю|яю|ую|ею|юю|ишь|ешь|ете|ите)$/.test(w)) // "делаю", "выгуливаю", "ремонтирую" are not topics
    .forEach(w => { freq[w] = (freq[w] || 0) + 1; });
  const top = Object.keys(freq).sort((a, b) => freq[b] - freq[a]).slice(0, 7);
  const c = (city || "").trim();
  const queries = [];
  top.forEach(w => queries.push(c ? w + " " + c : w));
  if (c) queries.push("барахолка " + c, "объявления " + c);
  if (audience) queries.push(c ? audience + " " + c : audience);
  return {
    summary: "",
    audience: [],
    queries: uniq(queries).slice(0, 12),
    tips: "",
    mode: "free",
  };
}

const uniq = arr => {
  const seen = new Set();
  return arr.filter(x => { const k = x.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
};

/* ---------- group scoring ---------- */

const FORBID = /(реклам[а-яё]*\s+(запрещ|не\s+публику|не\s+принима)|без\s+рекламы|рекламу\s+не|спам\s+(запрещ|=\s*бан|бан)|no\s+ads|no\s+advertising)/i;
const PAID = /(реклама\s*[:—-]|по\s+вопросам\s+рекламы|размещение\s+рекламы|прайс|реклама\s+платная|платное\s+размещение)/i;
const ALLOWED = /(объявлени|барахолк|доска|реклама\s+разрешена|пиар|взаимопиар|предлагайте\s+новост|предложк)/i;

// Fills g.ads ("allowed" | "paid" | "forbidden" | "unknown") from the group description without AI.
export function quickRules(g) {
  const d = (g.title + " " + (g.description || "")).slice(0, 3000);
  if (FORBID.test(d)) g.ads = "forbidden";
  else if (PAID.test(d)) g.ads = "paid";
  else if (ALLOWED.test(d)) g.ads = "allowed";
  else g.ads = "unknown";
  return g;
}

// Asks Claude to rate relevance and read the rules for a batch of groups.
// Mutates the groups: rel (0–10), ads, note.
export async function scoreGroups({ key, model, summary, text, groups, onProgress }) {
  const BATCH = 40;
  for (let i = 0; i < groups.length; i += BATCH) {
    const part = groups.slice(i, i + BATCH);
    const list = part.map((g, n) => ({ n, t: g.title, m: g.members || null, d: (g.description || "").replace(/\s+/g, " ").slice(0, 350) }));
    const prompt = `Пользователь хочет вручную опубликовать пост о своей услуге в тематических сообществах.
Суть предложения: ${summary || text.slice(0, 600)}

Ниже сообщества (n — номер, t — название, m — участники, d — описание). Для каждого оцени:
- rel — насколько аудитория сообщества подходит для этого предложения, от 0 (совсем мимо) до 10 (идеально);
- ads — что описание говорит про рекламу и объявления: "allowed" (объявления или реклама разрешены, это доска объявлений или барахолка), "paid" (реклама только платно или через админа), "forbidden" (реклама запрещена), "unknown" (не сказано);
- note — очень коротко по-русски важное из правил, если есть («объявления по пятницам», «только частные лица», «реклама через @admin»), иначе пустая строка.

Сообщества:
${JSON.stringify(list)}

Ответь ТОЛЬКО JSON без пояснений: {"r":[{"n":0,"rel":7,"ads":"unknown","note":""}]}`;
    try {
      const r = await ask(key, model, prompt, 3000);
      (r.r || []).forEach(x => {
        const g = part[x.n];
        if (!g) return;
        const rel = Number(x.rel);
        if (!isNaN(rel)) g.rel = Math.max(0, Math.min(10, rel));
        if (["allowed", "paid", "forbidden", "unknown"].includes(x.ads)) g.ads = x.ads;
        if (x.note) g.note = String(x.note).slice(0, 140);
      });
    } catch (e) {
      if (i === 0) throw e; // first batch failed: report; later failures keep what we have
    }
    onProgress && onProgress(Math.min(groups.length, i + BATCH), groups.length);
  }
}
