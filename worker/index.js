/**
 * Telegram-бот трекера: отвечает на команды. Cloudflare Worker (бесплатный план) с webhook.
 *
 * Секреты (wrangler secret put …):
 *   TELEGRAM_BOT_TOKEN  — токен бота
 *   ALLOWED_CHAT_IDS    — chat id через запятую; остальным бот не отвечает
 *   WEBHOOK_SECRET      — любая длинная строка; Telegram присылает её в заголовке, чужие запросы отбрасываются
 * Переменная (wrangler.toml → [vars]):
 *   SITE_URL            — адрес сайта на GitHub Pages, с «/» на конце
 *
 * Бот только читает публичные JSON с сайта, ничего не меняет и не использует LLM.
 */
const HOME_TZ = "Asia/Bishkek";
const STATUS = { confirmed: "✅", expected: "🟡", unknown: "⚪" };
const STAGES = { idea: "🔍 изучаю", preparing: "🛠 готовлю", submitted: "📨 подано", interview: "🎤 экзамен/интервью", result: "🏁 результат" };

const HELP = `Команды:
/deadlines — 5 ближайших дедлайнов
/exams — экзамены и регистрация
/todo — неготовые документы
/program &lt;id&gt; — кратко о программе (id — из /list)
/list — все программы и их id
/pending — что ждёт проверки в журнале
/help — эта справка

🟡 — дата ожидается по прошлым годам, ✅ — подтверждена официально.`;

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function plural(n) {
  const a = Math.abs(n), n10 = a % 10, n100 = a % 100;
  if (n10 === 1 && n100 !== 11) return "день";
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return "дня";
  return "дней";
}

/* ---------- даты (как на сайте) ---------- */
function tzOffsetMs(utcMs, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs;
}

function deadlineDate(dl) {
  if (!dl || !dl.date) return null;
  const [y, m, d] = dl.date.split("-").map(Number);
  const [hh, mm] = (dl.time || "23:59").split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  return new Date(guess - tzOffsetMs(guess, dl.timezone || HOME_TZ));
}

const ymd = (date) => new Intl.DateTimeFormat("en-CA", { timeZone: HOME_TZ }).format(date);
function daysLeft(dl) {
  const d = deadlineDate(dl);
  if (!d) return null;
  const a = ymd(d).split("-").map(Number), b = ymd(new Date()).split("-").map(Number);
  return Math.round((Date.UTC(a[0], a[1] - 1, a[2]) - Date.UTC(b[0], b[1] - 1, b[2])) / 86400000);
}

function fmt(dl) {
  const d = deadlineDate(dl);
  if (!d) return "дата неизвестна";
  const day = new Intl.DateTimeFormat("ru-RU", { timeZone: dl.timezone || HOME_TZ, day: "numeric", month: "long", year: "numeric" }).format(d);
  if (!dl.time) return day;
  if ((dl.timezone || HOME_TZ) === HOME_TZ) return `${day}, ${dl.time} по Бишкеку`;
  const local = new Intl.DateTimeFormat("ru-RU", { timeZone: HOME_TZ, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(d);
  return `${day}, ${dl.time} (${local} по Бишкеку)`;
}

/* ---------- данные с сайта ---------- */
async function load(env, file) {
  const r = await fetch(new URL(`data/${file}`, env.SITE_URL), { cf: { cacheTtl: 300 } });
  if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`);
  return r.json();
}

/* ---------- команды ---------- */
async function deadlines(env) {
  const { programs } = await load(env, "programs.json");
  const up = programs
    .filter((p) => (p.application_status || {}).stage !== "result")
    .map((p) => ({ p, n: daysLeft(p.deadline) })).filter((x) => x.n !== null && x.n >= 0)
    .sort((a, b) => a.n - b.n).slice(0, 5);
  if (!up.length) return "Ближайших дедлайнов с известной датой нет.";
  return "<b>Ближайшие дедлайны</b>\n\n" + up.map(({ p, n }) =>
    `${STATUS[p.deadline_status] || "⚪"} <b>${esc(p.name)}</b> — ${n} ${plural(n)}\n   ${esc(fmt(p.deadline))}`).join("\n");
}

async function exams(env) {
  const { events } = await load(env, "events.json").catch(() => ({ events: [] }));
  const rows = events.map((e) => {
    const reg = e.registration?.date ? e.registration : null;
    const nReg = reg ? daysLeft(reg) : null, nExam = e.date ? daysLeft({ date: e.date }) : null;
    let line = `${STATUS[e.status] || "⚪"} <b>${esc(e.name)}</b>`;
    if (reg && nReg >= 0) line += `\n   регистрация до ${esc(fmt(reg))} — через ${nReg} ${plural(nReg)}`;
    else if (e.date && nExam >= 0) line += `\n   экзамен через ${nExam} ${plural(nExam)}`;
    else if (!e.date) line += "\n   дата не назначена";
    else return null;
    return line;
  }).filter(Boolean);
  return rows.length ? "<b>Экзамены</b>\n\n" + rows.join("\n") : "Предстоящих экзаменов нет.";
}

async function todo(env) {
  const { programs } = await load(env, "programs.json");
  const rows = programs
    .map((p) => ({ p, n: daysLeft(p.deadline), left: (p.documents_checklist || []).filter((c) => !c.done) }))
    .filter((x) => x.left.length && (x.n === null || x.n >= 0) && (x.p.application_status || {}).stage !== "result")
    .sort((a, b) => (a.n ?? 9999) - (b.n ?? 9999)).slice(0, 6);
  if (!rows.length) return "Все документы отмечены как готовые 🎉";
  return "<b>Не готово</b> (по данным репозитория; отметки только в браузере сюда не попадают)\n\n" + rows.map(({ p, n, left }) =>
    `<b>${esc(p.name)}</b>${n !== null ? ` — ${n} ${plural(n)}` : ""}\n` + left.slice(0, 6).map((c) => `  • ${esc(c.title)}`).join("\n")
    + (left.length > 6 ? `\n  …и ещё ${left.length - 6}` : "")).join("\n\n");
}

async function list(env) {
  const { programs } = await load(env, "programs.json");
  return "<b>Программы</b>\n\n" + programs.map((p) => `<code>${esc(p.id)}</code> — ${esc(p.name)}`).join("\n");
}

async function program(env, id) {
  if (!id) return "Укажите id: /program mit (список — /list)";
  const { programs } = await load(env, "programs.json");
  const p = programs.find((x) => x.id === id.toLowerCase());
  if (!p) return `Программа «${esc(id)}» не найдена. Список — /list`;
  const n = daysLeft(p.deadline), cl = p.documents_checklist || [], done = cl.filter((c) => c.done).length;
  const stage = STAGES[(p.application_status || {}).stage];
  const lines = [
    `<b>${esc(p.name)}</b> (${esc(p.country)}, ${esc(p.type)})`,
    `Дедлайн: ${esc(fmt(p.deadline))}${n !== null && n >= 0 ? ` — через ${n} ${plural(n)}` : ""} ${STATUS[p.deadline_status] || ""}`,
  ];
  if (p.deadline?.note) lines.push(`<i>${esc(p.deadline.note)}</i>`);
  if (stage) lines.push(`Этап: ${stage}`);
  if (cl.length) lines.push(`Документы: ${done} из ${cl.length}`);
  for (const [k, label] of [["language", "Язык"], ["exams", "Экзамены"]]) {
    const v = p.requirements?.[k]?.value;
    if (v) lines.push(`${label}: ${esc(v)}`);
  }
  lines.push(`\n<a href="${esc(new URL(`#/p/${p.id}`, env.SITE_URL).href)}">Открыть карточку</a>`);
  return lines.join("\n");
}

async function pending(env) {
  const { entries } = await load(env, "changelog.json");
  const items = entries.filter((e) => e.status === "pending");
  if (!items.length) return "В журнале ничего не ждёт проверки.";
  return `<b>Ждут проверки: ${items.length}</b>\n\n` + items.slice(-8).map((e) => {
    const what = e.kind === "new_program" ? `🆕 ${esc(e.new?.name)}` : `${esc(e.program_id)}: ${esc(e.field)} → ${esc(e.new?.date || e.new?.value || "")}`;
    return `• ${what}`;
  }).join("\n") + `\n\n<a href="${esc(new URL("#/log", env.SITE_URL).href)}">Открыть журнал</a>`;
}

async function answer(env, text) {
  const [cmd, ...args] = text.trim().split(/\s+/);
  switch (cmd.split("@")[0].toLowerCase()) {
    case "/start": case "/help": return HELP;
    case "/deadlines": return deadlines(env);
    case "/exams": return exams(env);
    case "/todo": return todo(env);
    case "/list": return list(env);
    case "/program": return program(env, args[0]);
    case "/pending": return pending(env);
    default: return "Не понимаю. " + HELP;
  }
}

async function send(env, chatId, text) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), parse_mode: "HTML", disable_web_page_preview: true }),
  });
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("ok");
    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
    const update = await request.json().catch(() => null);
    const msg = update?.message;
    if (!msg?.text) return new Response("ok");
    const allowed = String(env.ALLOWED_CHAT_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!allowed.includes(String(msg.chat.id))) return new Response("ok");  // чужим молча не отвечаем
    let reply;
    try { reply = await answer(env, msg.text); } catch (err) { reply = "⚠️ Не удалось загрузить данные: " + esc(err.message); }
    await send(env, msg.chat.id, reply);
    return new Response("ok");
  },
};
