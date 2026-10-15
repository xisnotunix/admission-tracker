/* Трекер поступления — статическое приложение без сборки.
   Данные: data/programs.json, data/changelog.json, data/state.json (из репозитория).
   Локально (localStorage): отметки чек-листа и настройки GitHub. */
"use strict";

const HOME_TZ = "Asia/Bishkek";
const LS = { checklist: "tracker.checklist", settings: "tracker.settings", sent: "tracker.sent", profile: "tracker.profile", chat: "tracker.chat", status: "tracker.status" };
const STATUS = {
  confirmed: { label: "подтверждён", cls: "confirmed", icon: "✓" },
  expected: { label: "ожидается", cls: "expected", icon: "~" },
  unknown: { label: "не проверено", cls: "unknown", icon: "?" },
};
/* Профиль абитуриента. Хранится только в этом браузере — репозиторий публичный. */
const PROFILE_FIELDS = [
  { key: "gpa", label: "Средний балл (5-балльная шкала)", type: "number", step: "0.01", placeholder: "4.8" },
  { key: "gpa_percent", label: "Средний балл в % (если просят)", type: "number", step: "1", placeholder: "92" },
  { key: "ielts", label: "IELTS (общий)", type: "number", step: "0.5", placeholder: "6.5", cmp: "ielts" },
  { key: "toefl_ibt", label: "TOEFL iBT", type: "number", step: "1", placeholder: "90", cmp: "toefl_ibt" },
  { key: "duolingo", label: "Duolingo English Test", type: "number", step: "5", placeholder: "120", cmp: "duolingo" },
  { key: "sat", label: "SAT", type: "number", step: "10", placeholder: "1350", cmp: "sat" },
  { key: "ort", label: "ОРТ (основной тест)", type: "number", step: "1", placeholder: "180", cmp: "ort" },
  { key: "jlpt", label: "JLPT (уровень)", type: "text", placeholder: "N4" },
  { key: "birth_date", label: "Дата рождения", type: "date" },
  { key: "graduation", label: "Окончание школы", type: "text", placeholder: "июнь 2027" },
  { key: "majors", label: "Направления", type: "text", placeholder: "Computer Science, Social Studies" },
  { key: "olympiads", label: "Олимпиады и награды", type: "textarea" },
  { key: "activities", label: "Внеучебная деятельность", type: "textarea" },
  { key: "notes", label: "Заметки", type: "textarea" },
];
const THRESHOLD_LABELS = { ielts: "IELTS", toefl_ibt: "TOEFL iBT", duolingo: "Duolingo", sat: "SAT", ort: "ОРТ", gpa_percent: "Средний балл, %", age_min: "Возраст" };

const REQ_LABELS = { language: "Язык", exams: "Экзамены", documents: "Документы", min_grades: "Минимальные оценки" };
const FIELD_LABELS = { deadline: "Дедлайн", opens: "Открытие приёма", ...Object.fromEntries(
  Object.entries(REQ_LABELS).map(([k, v]) => ["requirements." + k, v])) };

const state = { programs: [], changelog: [], sources: {}, whitelist: [], filter: "all", logFilter: "pending", loadedAt: null };

/* ---------- утилиты ---------- */
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "#");

function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* приватный режим */ }
}

function toast(msg, ms = 3500) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}

/* ---------- даты ---------- */
function tzOffsetMs(utcMs, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs;
}

/** Момент дедлайна (Date) или null. Без времени — 23:59 в часовом поясе дедлайна. */
function deadlineDate(dl) {
  if (!dl || !dl.date) return null;
  const [y, m, d] = dl.date.split("-").map(Number);
  const [hh, mm] = (dl.time || "23:59").split(":").map(Number);
  const tz = dl.timezone || HOME_TZ;
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  try { return new Date(guess - tzOffsetMs(guess, tz)); } catch { return new Date(guess); }
}

const ymd = (date, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(date);
function daysLeft(dl) {
  const d = deadlineDate(dl);
  if (!d) return null;
  const a = ymd(d, HOME_TZ).split("-").map(Number), b = ymd(new Date(), HOME_TZ).split("-").map(Number);
  return Math.round((Date.UTC(a[0], a[1] - 1, a[2]) - Date.UTC(b[0], b[1] - 1, b[2])) / 86400000);
}

function plural(n, one, few, many) {
  const n10 = n % 10, n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
  return many;
}

/** Привычное название пояса: CET/CEST, JST, иначе GMT+N. */
function tzLabel(tz, date) {
  if (tz === HOME_TZ) return "по Бишкеку";
  if (tz === "Asia/Tokyo") return "JST";
  const h = Math.round(tzOffsetMs(date.getTime(), tz) / 3600000);
  if (tz.startsWith("Europe/") && (h === 1 || h === 2)) return h === 1 ? "CET" : "CEST";
  return h === 0 ? "UTC" : `GMT${h > 0 ? "+" : ""}${h}`;
}

const fmtDay = (d, tz) => new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: tz }).format(d).replace(/\s?г\.$/, "");

/** Дедлайн так, как он объявлен: «15 января 2027, 14:00 CET». */
function fmtDeadline(dl) {
  const d = deadlineDate(dl);
  if (!d) return "дата неизвестна";
  const tz = dl.timezone || HOME_TZ;
  return dl.time ? `${fmtDay(d, tz)}, ${dl.time} ${tzLabel(tz, d)}` : fmtDay(d, tz);
}

/** Тот же момент по времени Бишкека, или null, если пересчитывать нечего. */
function fmtDeadlineHome(dl) {
  const d = deadlineDate(dl);
  if (!d || !dl.time || (dl.timezone || HOME_TZ) === HOME_TZ) return null;
  const t = new Intl.DateTimeFormat("ru-RU", { timeZone: HOME_TZ, hour: "2-digit", minute: "2-digit" }).format(d);
  return `${fmtDay(d, HOME_TZ)}, ${t}`;
}

function fmtStamp(iso) {
  if (!iso) return "никогда";
  return new Intl.DateTimeFormat("ru-RU", { timeZone: HOME_TZ, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

/* ---------- данные ---------- */
async function loadData() {
  const get = (f) => fetch(`data/${f}?t=${Date.now()}`, { cache: "no-store" }).then((r) => {
    if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
    return r.json();
  });
  const [programs, changelog, st, src] = await Promise.all([
    get("programs.json"), get("changelog.json"),
    get("state.json").catch(() => ({ sources: {} })), get("sources.json").catch(() => ({ sources: [] })),
  ]);
  state.sourceList = src.sources || [];
  state.whitelist = state.sourceList.filter((s) => s.enabled && s.url).map((s) => s.url);
  state.programs = programs.programs;
  state.changelog = changelog.entries || [];
  state.sources = st.sources || {};
  state.loadedAt = new Date();
}

const programById = (id) => state.programs.find((p) => p.id === id);
const pendingFor = (pid) => state.changelog.filter((e) => e.status === "pending" && (!pid || e.program_id === pid));
const sourceErrors = (p) => Object.values(state.sources).filter((s) => s.error && (p.official_urls || []).includes(s.url));

/** Чек-лист с учётом локальных отметок поверх данных репозитория. */
const profile = () => lsGet(LS.profile, {});

/* ---------- статус заявки ---------- */
const STAGES = [
  { key: "idea", label: "Изучаю", icon: "🔍" },
  { key: "preparing", label: "Готовлю", icon: "🛠" },
  { key: "submitted", label: "Подано", icon: "📨" },
  { key: "interview", label: "Экзамен / интервью", icon: "🎤" },
  { key: "result", label: "Результат", icon: "🏁" },
];
const OUTCOMES = { accepted: "✅ Приняли", rejected: "❌ Отказ", waitlist: "⏳ Лист ожидания" };
const ACTIVE_STAGES = ["preparing", "submitted", "interview"];

/** Статус: локальный (этот браузер) поверх сохранённого в репозитории. */
function appStatus(p) {
  const local = lsGet(LS.status, {})[p.id];
  return { stage: "idea", outcome: null, note: "", ...(p.application_status || {}), ...(local || {}) };
}

function stageBadge(p) {
  const st = appStatus(p);
  if (st.stage === "idea") return "";
  const s = STAGES.find((x) => x.key === st.stage);
  const text = st.stage === "result" && st.outcome ? OUTCOMES[st.outcome] : `${s.icon} ${s.label}`;
  const cls = st.outcome === "accepted" ? "confirmed" : st.outcome === "rejected" ? "unknown" : "review";
  return `<span class="badge ${cls}">${esc(text)}</span>`;
}

function statusBlock(p) {
  const st = appStatus(p);
  return `<h2>Моя заявка</h2>
    <div class="card">
      <div class="stages" role="group" aria-label="Этап заявки">
        ${STAGES.map((s) => `<button class="stage" data-stage="${s.key}" data-program="${esc(p.id)}" aria-pressed="${st.stage === s.key}">
          <span>${s.icon}</span>${esc(s.label)}</button>`).join("")}
      </div>
      ${st.stage === "result" ? `<div class="actions">${Object.entries(OUTCOMES).map(([k, l]) =>
        `<button class="chip" data-outcome="${k}" data-program="${esc(p.id)}" aria-pressed="${st.outcome === k}">${l}</button>`).join("")}</div>` : ""}
      <label class="input"><span>Заметка (номер заявки, логин портала без пароля, что дальше)</span>
        <textarea id="status-note" data-program="${esc(p.id)}" rows="2">${esc(st.note || "")}</textarea></label>
      ${st.updated ? `<p class="small muted">Обновлено: ${fmtStamp(st.updated)}</p>` : ""}
    </div>`;
}

async function setStatus(pid, patch) {
  const all = lsGet(LS.status, {});
  const cur = appStatus(programById(pid));
  const next = { ...cur, ...patch, updated: new Date().toISOString() };
  if (patch.stage && patch.stage !== "result") next.outcome = null;
  all[pid] = next; lsSet(LS.status, all); render();
  if (patch.note !== undefined) return;  // заметки остаются только на устройстве
  try {
    const value = next.stage + (next.outcome ? ":" + next.outcome : "");
    if (await dispatchReview({ action: "status", program_id: pid, item_id: value })) toast("Статус сохранён в репозиторий");
  } catch (err) { toast("Сохранено только на устройстве: " + err.message, 6000); }
}

/** Сравнение профиля с числовыми порогами программы. */
function profileMatch(p) {
  const pr = profile(), out = [];
  for (const [k, t] of Object.entries(p.thresholds || {})) {
    if (typeof t?.value !== "number") continue;
    let mine = null;
    if (k === "age_min" && pr.birth_date) {
      const b = new Date(pr.birth_date), ref = new Date(new Date().getFullYear() + 1, 7, 31); // 31 августа следующего года
      mine = ref.getFullYear() - b.getFullYear() - (ref < new Date(ref.getFullYear(), b.getMonth(), b.getDate()) ? 1 : 0);
    } else if (pr[k] !== undefined && pr[k] !== "") mine = Number(pr[k]);
    out.push({ key: k, label: THRESHOLD_LABELS[k] || k, need: t.value, mine, ok: mine === null ? null : mine >= t.value, t });
  }
  return out;
}

function checklist(p) {
  const local = lsGet(LS.checklist, {})[p.id] || {};
  return (p.documents_checklist || []).map((c) => ({ ...c, done: c.id in local ? local[c.id] : !!c.done }));
}

/* ---------- GitHub (необязательно: подтверждение из приложения) ---------- */
function repoInfo() {
  const s = lsGet(LS.settings, {});
  let owner = s.owner, repo = s.repo;
  const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
  if (m) {
    owner = owner || m[1];
    repo = repo || location.pathname.split("/").filter(Boolean)[0] || `${m[1]}.github.io`;
  }
  return { owner, repo, branch: s.branch || "main", token: s.token || "" };
}

function actionsUrl() {
  const { owner, repo } = repoInfo();
  return owner && repo ? `https://github.com/${owner}/${repo}/actions/workflows/review.yml` : null;
}

async function dispatchReview(inputs) {
  const { owner, repo, branch, token } = repoInfo();
  if (!owner || !repo || !token) return false;
  const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows/review.yml/dispatches`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    body: JSON.stringify({ ref: branch, inputs }),
  });
  if (r.status !== 204) throw new Error(`GitHub API: ${r.status} ${await r.text()}`);
  return true;
}

/* ---------- компоненты ---------- */
function statusBadge(p) {
  const s = STATUS[p.deadline_status] || STATUS.unknown;
  return `<span class="badge ${s.cls}" title="Статус дедлайна">${s.icon} ${s.label}</span>`;
}

function countdown(p) {
  const n = daysLeft(p.deadline);
  if (n === null) return `<div class="count none"><div class="n">—</div><div class="u">нет даты</div></div>`;
  if (n < 0) return `<div class="count none"><div class="n">прошёл</div><div class="u">${-n} ${plural(-n, "день", "дня", "дней")} назад</div></div>`;
  const cls = n <= 7 ? "urgent" : n <= 30 ? "soon" : "";
  return `<div class="count ${cls}"><div class="n">${n}</div><div class="u">${plural(n, "день", "дня", "дней")}</div></div>`;
}

function quoteBlock(obj) {
  if (!obj) return "";
  let html = "";
  if (obj.quote) html += `<blockquote>«${esc(obj.quote)}»</blockquote>`;
  if (obj.source_url) html += `<div class="src">Источник: <a href="${esc(safeUrl(obj.source_url))}" target="_blank" rel="noopener">${esc(obj.source_url)}</a></div>`;
  return html;
}

function fmtValue(field, v) {
  if (v == null) return `<span class="empty">нет</span>`;
  if (typeof v !== "object") return esc(v);
  if (field === "deadline") return esc(v.date ? fmtDeadline(v) : "нет даты") + (v.status ? ` <span class="muted small">(${esc(STATUS[v.status]?.label || v.status)})</span>` : "");
  if (field === "opens") return esc(v.date || v.text || "нет");
  return v.value != null ? esc(v.value) : `<span class="empty">нет</span>`;
}

/* ---------- экраны ---------- */
function viewHome() {
  const filters = [["all", "Все"], ["active", "Активные"], ["стипендия", "Стипендии"], ["вуз", "Вузы"]];
  const list = state.programs
    .filter((p) => state.filter === "all" || (state.filter === "active" ? ACTIVE_STAGES.includes(appStatus(p).stage) : p.type === state.filter))
    .map((p) => ({ p, n: deadlineDate(p.deadline), done: appStatus(p).stage === "result" }))
    .sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;     // с результатом — вниз
      const pa = a.n && a.n >= Date.now(), pb = b.n && b.n >= Date.now();
      if (pa !== pb) return pa ? -1 : 1;               // будущие дедлайны — сверху
      if (a.n && b.n) return a.n - b.n;
      if (!!a.n !== !!b.n) return a.n ? -1 : 1;
      const prio = { high: 0, medium: 1, low: 2 };
      return (prio[a.p.priority] ?? 1) - (prio[b.p.priority] ?? 1);
    });

  const pending = pendingFor().length;
  return `
    <div class="chips" role="group" aria-label="Фильтр">
      ${filters.map(([v, l]) => `<button class="chip" data-filter="${v}" aria-pressed="${state.filter === v}">${l}</button>`).join("")}
    </div>
    ${pending ? `<a class="card" href="#/log" style="border-color:var(--violet)"><span class="badge review">⚑ ${pending}</span> ${plural(pending, "изменение требует", "изменения требуют", "изменений требуют")} проверки</a>` : ""}
    ${list.map(({ p }) => {
      const cl = checklist(p), done = cl.filter((c) => c.done).length;
      const pend = pendingFor(p.id).length, errs = sourceErrors(p).length;
      return `
      <a class="card prog" href="#/p/${encodeURIComponent(p.id)}">
        <div>
          <h3>${esc(p.name)}</h3>
          <div class="muted small">${esc(p.country)} · ${esc(p.type)} · ${esc(p.deadline?.date ? fmtDeadline(p.deadline) : "дедлайн неизвестен")}</div>
        </div>
        ${countdown(p)}
        <div class="meta">
          ${statusBadge(p)}
          ${stageBadge(p)}
          ${pend ? `<span class="badge review">⚑ требует проверки</span>` : ""}
          ${errs ? `<span class="badge error">ошибка источника</span>` : ""}
          ${p.priority === "low" ? `<span class="badge plain">низкий приоритет</span>` : ""}
          ${cl.length ? `<span class="muted small">документы ${done}/${cl.length}</span>` : ""}
        </div>
        ${cl.length ? `<div class="progress"><i style="width:${(done / cl.length) * 100}%"></i></div>` : ""}
      </a>`;
    }).join("") || `<p class="muted center">${state.filter === "active" ? "Нет программ в работе — отметьте этап на карточке программы" : "Нет программ"}</p>`}
    <p class="muted small center">Данные загружены ${fmtStamp(state.loadedAt.toISOString())} ·
      <a href="data/deadlines.ics" download="deadlines.ics">📅 Скачать в календарь</a> · <a href="#/settings">подписка</a></p>`;
}

function viewProgram(id) {
  const p = programById(id);
  if (!p) return `<a class="back" href="#/">← Назад</a><p>Программа не найдена.</p>`;
  const cl = checklist(p), done = cl.filter((c) => c.done).length;
  const pend = pendingFor(p.id);
  const req = p.requirements || {};
  const opens = p.opens || {};

  return `
    <a class="back" href="#/">← Все программы</a>
    <div class="card hero">
      <h1>${esc(p.name)}</h1>
      <div class="muted small" style="margin:4px 0 12px">${esc(p.country)} · ${esc(p.type)}${p.priority === "low" ? " · низкий приоритет" : ""}</div>
      <div class="prog">
        <div>
          <div class="label muted small">ДЕДЛАЙН</div>
          <div><b>${esc(fmtDeadline(p.deadline))}</b></div>
          ${fmtDeadlineHome(p.deadline) ? `<div class="small muted">По Бишкеку: ${esc(fmtDeadlineHome(p.deadline))}</div>` : ""}
        </div>
        ${countdown(p)}
        <div class="meta">${statusBadge(p)}${pend.length ? `<a href="#/log" class="badge review">⚑ ${pend.length} на проверке</a>` : ""}</div>
      </div>
      ${p.deadline?.note ? `<p class="small muted">${esc(p.deadline.note)}</p>` : ""}
      ${quoteBlock(p.deadline)}
    </div>

    ${statusBlock(p)}

    <h2>Основное</h2>
    <div class="card">
      <dl class="kv">
        <dt>Приём открывается</dt><dd>${esc(opens.date || opens.text || "неизвестно")} ${opens.status ? `<span class="badge ${STATUS[opens.status]?.cls || "unknown"}">${esc(STATUS[opens.status]?.label || opens.status)}</span>` : ""}${quoteBlock(opens)}</dd>
        <dt>Кто выдвигает</dt><dd>${p.nominating_body?.value ? esc(p.nominating_body.value) : `<span class="empty">не указано</span>`}${p.nominating_body?.note ? `<div class="small muted">${esc(p.nominating_body.note)}</div>` : ""}${quoteBlock(p.nominating_body)}</dd>
        <dt>Проверено агентом</dt><dd>${fmtStamp(p.last_checked)}</dd>
        <dt>Последнее изменение</dt><dd>${fmtStamp(p.last_changed)}</dd>
      </dl>
    </div>

    ${matchBlock(p)}

    <h2>Требования</h2>
    <div class="card">
      ${Object.entries(REQ_LABELS).map(([k, label]) => {
        const f = req[k] || {};
        return `<div class="field"><div class="label">${label}</div>
          <div>${f.value ? esc(f.value) : `<span class="empty">нет данных</span>`}</div>${quoteBlock(f)}</div>`;
      }).join("")}
    </div>

    <h2>Документы ${cl.length ? `<span class="muted small">${done} из ${cl.length}</span>` : ""}</h2>
    <div class="card">
      ${cl.length ? cl.map((c) => `
        <label class="check ${c.done ? "done" : ""}">
          <input type="checkbox" data-check="${esc(c.id)}" data-program="${esc(p.id)}" ${c.done ? "checked" : ""}>
          <span>${esc(c.title)}${c.url ? ` <a href="${esc(safeUrl(c.url))}" target="_blank" rel="noopener" class="small" title="Открыть форму / страницу">📎</a>` : ""}</span>
        </label>`).join("") : `<span class="empty">Чек-лист пуст — добавьте пункты в programs.json</span>`}
    </div>

    ${(p.files || []).length ? `<h2>Формы и официальные документы</h2>
    <div class="card">${p.files.map((f) => `<div class="field">📄 <a href="${esc(safeUrl(f.url))}" target="_blank" rel="noopener">${esc(f.title)}</a></div>`).join("")}</div>` : ""}

    <h2>Официальные источники</h2>
    <div class="card">
      ${(p.official_urls || []).length ? p.official_urls.map((u) => {
        const s = Object.values(state.sources).find((x) => x.url === u);
        return `<div class="field"><a href="${esc(safeUrl(u))}" target="_blank" rel="noopener">${esc(u)}</a>
          ${s ? `<div class="small muted">проверено ${fmtStamp(s.last_checked)}${s.error ? ` · <span style="color:var(--red)">ошибка: ${esc(s.error)}</span>` : ""}</div>`
            : `<div class="small muted">${state.whitelist.includes(u) ? "в белом списке, ещё не проверялся" : "не в белом списке агента"}</div>`}</div>`;
      }).join("") : `<span class="empty">Не добавлены — внесите в programs.json и data/sources.json</span>`}
    </div>

    ${p.notes ? `<h2>Заметки</h2><div class="card">${esc(p.notes)}</div>` : ""}
    ${p.reviewed ? `<p class="small muted center">Данные вручную сверены с источниками: ${esc(p.reviewed)}</p>` : ""}
    <button class="chat-fab" data-chat="${esc(p.id)}" aria-label="Задать вопрос по программе">💬</button>`;
}

function matchBlock(p) {
  const m = profileMatch(p);
  if (!m.length) return "";
  const filled = m.some((x) => x.mine !== null);
  return `<h2>Мои баллы vs требования</h2>
    <div class="card">
      ${m.map((x) => `<div class="field">
        <div class="label">${esc(x.label)}</div>
        <div>минимум <b>${esc(x.need)}</b> · у меня ${x.mine === null ? `<span class="empty">не указано</span>`
          : `<b>${esc(x.mine)}</b> ${x.ok ? `<span class="badge confirmed">✓ проходит</span>` : `<span class="badge error">✕ не хватает</span>`}`}</div>
        ${x.t.note ? `<div class="small muted">${esc(x.t.note)}</div>` : ""}${quoteBlock(x.t)}
      </div>`).join("")}
      ${filled ? "" : `<p class="small muted">Заполните <a href="#/profile">профиль</a>, чтобы увидеть сравнение.</p>`}
    </div>`;
}

function entryCard(e) {
  const p = programById(e.program_id);
  const sent = lsGet(LS.sent, {})[e.id];
  const statusBadges = {
    pending: `<span class="badge review">требует проверки</span>`,
    approved: `<span class="badge confirmed">подтверждено</span>`,
    rejected: `<span class="badge unknown">отклонено</span>`,
    info: `<span class="badge plain">страница</span>`,
  };
  let body = "";
  if (e.kind === "new_program") {
    const n = e.new || {};
    body = `<dl class="change">
      <dt>Новая программа</dt><dd><b>${esc(n.name)}</b></dd>
      ${n.country ? `<dt>Страна</dt><dd>${esc(n.country)}</dd>` : ""}
      ${n.level ? `<dt>Уровень</dt><dd>${esc(n.level)}</dd>` : ""}
      ${n.deadline_text ? `<dt>Срок</dt><dd>${esc(n.deadline_text)}</dd>` : ""}
      ${n.url ? `<dt>Ссылка</dt><dd><a href="${esc(safeUrl(n.url))}" target="_blank" rel="noopener">${esc(n.url)}</a></dd>` : ""}
    </dl>${quoteBlock({ quote: e.quote, source_url: e.source_url })}`;
    if (e.status === "pending") {
      body += sent
        ? `<p class="small muted">Отправлено: ${sent === "approve" ? "добавить" : "отклонить"}.</p>`
        : `<div class="actions">
            <button class="btn primary" data-review="approve" data-id="${esc(e.id)}">＋ Добавить в трекер</button>
            <button class="btn danger" data-review="reject" data-id="${esc(e.id)}">✕ Не интересно</button>
          </div>`;
    }
  } else if (e.kind === "field") {
    body = `<dl class="change">
      <dt>Поле</dt><dd><b>${esc(FIELD_LABELS[e.field] || e.field)}</b></dd>
      <dt>Было</dt><dd>${fmtValue(e.field, e.old)}</dd>
      <dt>Стало</dt><dd><b>${fmtValue(e.field, e.new)}</b></dd>
    </dl>${quoteBlock({ quote: e.quote, source_url: e.source_url })}`;
    if (e.status === "pending") {
      body += sent
        ? `<p class="small muted">Отправлено: ${sent === "approve" ? "подтвердить" : "отклонить"}. Обновится после выполнения workflow (~1 мин).</p>`
        : `<div class="actions">
            <button class="btn primary" data-review="approve" data-id="${esc(e.id)}">✓ Подтвердить</button>
            <button class="btn danger" data-review="reject" data-id="${esc(e.id)}">✕ Отклонить</button>
          </div>`;
    }
  } else {
    const d = e.diff;
    body = `<div>${esc(e.summary || "Изменение страницы")}</div>
      <div class="src"><a href="${esc(safeUrl(e.source_url))}" target="_blank" rel="noopener">${esc(e.source_url)}</a></div>
      ${d ? `<details><summary class="small">+${d.added_total} / −${d.removed_total} строк</summary><ul class="diff">
        ${d.added.map((l) => `<li class="add">+ ${esc(l)}</li>`).join("")}
        ${d.removed.map((l) => `<li class="del">− ${esc(l)}</li>`).join("")}
      </ul></details>` : ""}`;
  }
  return `<div class="card entry">
    <div class="head"><b>${esc(p ? p.name : e.kind === "new_program" ? "Поиск программ" : (e.program_id || "Каталог конкурсов"))}</b>${statusBadges[e.status] || ""}</div>
    <div class="muted small">${fmtStamp(e.created)} · ID ${esc(e.id)}${e.resolved ? ` · решено ${fmtStamp(e.resolved)}` : ""}</div>
    ${body}
  </div>`;
}

function viewLog() {
  const filters = [["pending", "Требуют проверки"], ["field", "Изменения данных"], ["all", "Всё"]];
  const list = state.changelog.filter((e) =>
    state.logFilter === "all" || (state.logFilter === "pending" ? e.status === "pending" : e.kind !== "page"))
    .slice().reverse();
  return `
    <h1 style="margin-bottom:12px">Журнал изменений</h1>
    <div class="chips" role="group">
      ${filters.map(([v, l]) => `<button class="chip" data-logfilter="${v}" aria-pressed="${state.logFilter === v}">${l}</button>`).join("")}
    </div>
    ${list.map(entryCard).join("") || `<p class="muted center">${state.logFilter === "pending" ? "Нечего проверять 🎉" : "Журнал пуст"}</p>`}
    ${!repoInfo().token ? `<p class="small muted">Кнопки «Подтвердить/Отклонить» без токена копируют ID и открывают GitHub Actions → Review change. Токен можно задать в настройках.</p>` : ""}`;
}

function viewSettings() {
  const s = lsGet(LS.settings, {}), r = repoInfo();
  const local = lsGet(LS.checklist, {});
  const localCount = Object.values(local).reduce((n, o) => n + Object.keys(o).length, 0);
  return `
    <h1>Настройки</h1>
    <h2>Репозиторий GitHub</h2>
    <div class="card">
      <p class="small muted" style="margin-top:0">На GitHub Pages владелец и имя репозитория определяются автоматически${r.owner ? `: <b>${esc(r.owner)}/${esc(r.repo)}</b>` : ""}.</p>
      <label class="input"><span>Владелец (owner)</span><input id="s-owner" value="${esc(s.owner || "")}" placeholder="${esc(r.owner || "username")}" autocapitalize="off"></label>
      <label class="input"><span>Репозиторий</span><input id="s-repo" value="${esc(s.repo || "")}" placeholder="${esc(r.repo || "admission-tracker")}" autocapitalize="off"></label>
      <label class="input"><span>Ветка</span><input id="s-branch" value="${esc(s.branch || "")}" placeholder="main" autocapitalize="off"></label>
      <label class="input"><span>Fine-grained токен (необязательно, только Actions: write для этого репозитория)</span>
        <input id="s-token" type="password" value="${esc(s.token || "")}" placeholder="github_pat_…" autocomplete="off"></label>
      <p class="small muted">С токеном кнопки «Подтвердить» и отметки чек-листа сразу запускают workflow и сохраняются в репозиторий (с коммитом). Токен хранится только в этом браузере.</p>
      <button class="btn primary" id="s-save">Сохранить</button>
    </div>

    <h2>Календарь дедлайнов</h2>
    <div class="card">
      <p class="small muted" style="margin-top:0">Подпишитесь — и дедлайны появятся в календаре телефона, а при изменениях обновятся сами (Google обновляет раз в несколько часов). Напоминания за 7 и 1 день.</p>
      <label class="input"><span>Адрес календаря</span><input id="ics-url" readonly value="${esc(new URL("data/deadlines.ics", location.href.split("#")[0]).href)}"></label>
      <div class="actions">
        <button class="btn primary" id="ics-copy">Скопировать адрес</button>
        <a class="btn" href="data/deadlines.ics" download="deadlines.ics">Скачать .ics</a>
      </div>
      <p class="small muted">Google Календарь (на компьютере): «Другие календари» → «＋» → «Добавить по URL» → вставить адрес. iPhone: Настройки → Календарь → Учётные записи → Добавить → Другое → «Подписной календарь». Подписка работает только с адресом сайта на GitHub Pages, не с localhost.</p>
    </div>

    <h2>Чат-помощник (Gemini)</h2>
    <div class="card">
      <p class="small muted" style="margin-top:0">Ключ бесплатный: <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a>. Хранится только в этом браузере, запросы идут напрямую в Google. Лучше создать отдельный ключ и ограничить его адресом вашего сайта.</p>
      <label class="input"><span>Gemini API key</span><input id="s-gemini" type="password" value="${esc(s.gemini || "")}" placeholder="AIza…" autocomplete="off"></label>
      <label class="input"><span>Модель</span><input id="s-model" value="${esc(s.model || "")}" placeholder="gemini-2.5-flash" autocapitalize="off"></label>
      <button class="btn primary" id="s-ai-save">Сохранить</button>
    </div>

    <h2>Чек-листы на этом устройстве</h2>
    <div class="card">
      <p class="small muted" style="margin-top:0">Локальных отметок: ${localCount}. Они хранятся в браузере и показываются поверх данных репозитория.</p>
      <div class="actions">
        <button class="btn" id="s-export">Скопировать JSON</button>
        <button class="btn danger" id="s-reset">Сбросить локальные отметки</button>
      </div>
    </div>

    <h2>Состояние агента</h2>
    <div class="card">
      ${Object.entries(state.sources).map(([id, s]) => `<div class="field"><b>${esc(id)}</b>
        <div class="small muted">проверено ${fmtStamp(s.last_checked)} · изменено ${fmtStamp(s.last_changed)}</div>
        ${s.error ? `<div class="small" style="color:var(--red)">${esc(s.error)}</div>` : ""}</div>`).join("") || `<span class="empty">Агент ещё не запускался</span>`}
      ${actionsUrl() ? `<p class="small"><a href="${esc(actionsUrl().replace("review.yml", "check-sources.yml"))}" target="_blank" rel="noopener">Запустить проверку вручную →</a></p>` : ""}
    </div>`;
}

function viewProfile() {
  const pr = profile();
  const input = (f) => f.type === "textarea"
    ? `<textarea id="pf-${f.key}" rows="3">${esc(pr[f.key] || "")}</textarea>`
    : `<input id="pf-${f.key}" type="${f.type}" ${f.step ? `step="${f.step}" inputmode="decimal"` : ""} value="${esc(pr[f.key] ?? "")}" placeholder="${esc(f.placeholder || "")}">`;
  const rows = state.programs.map((p) => ({ p, m: profileMatch(p).filter((x) => x.mine !== null) })).filter((x) => x.m.length);
  return `
    <h1>Мой профиль</h1>
    <p class="small muted">Хранится только в этом браузере и не попадает в публичный репозиторий. Используется для сравнения с требованиями и в чате.</p>
    <div class="card">
      ${PROFILE_FIELDS.map((f) => `<label class="input"><span>${esc(f.label)}</span>${input(f)}</label>`).join("")}
      <div class="actions"><button class="btn primary" id="pf-save">Сохранить</button><button class="btn" id="pf-export">Скопировать JSON</button></div>
    </div>
    ${rows.length ? `<h2>Сравнение с требованиями</h2>
      <div class="card">${rows.map(({ p, m }) => `<div class="field"><a href="#/p/${encodeURIComponent(p.id)}"><b>${esc(p.name)}</b></a>
        <div class="small">${m.map((x) => `${esc(x.label)}: ${esc(x.mine)} / мин. ${esc(x.need)} ${x.ok ? "✓" : "✕"}`).join(" · ")}</div></div>`).join("")}</div>` : ""}`;
}

/* ---------- роутер и события ---------- */
function render() {
  if (!state.loadedAt) return;  // данные ещё грузятся
  const hash = location.hash || "#/";
  let html, tab = "home";
  if (hash.startsWith("#/p/")) html = viewProgram(decodeURIComponent(hash.slice(4)));
  else if (hash === "#/log") { html = viewLog(); tab = "log"; }
  else if (hash === "#/settings") { html = viewSettings(); tab = "settings"; }
  else if (hash === "#/profile") { html = viewProfile(); tab = "profile"; }
  else html = viewHome();
  $("#app").innerHTML = html + (hash.startsWith("#/p/") ? "" : `<button class="chat-fab" data-chat="all" aria-label="Задать вопрос">💬</button>`);
  document.querySelectorAll(".tabbar a").forEach((a) => a.classList.toggle("active", a.dataset.tab === tab));
  const n = pendingFor().length, badge = $("#pending-badge");
  badge.hidden = !n; badge.textContent = n;
}

async function onReview(decision, id) {
  const sent = lsGet(LS.sent, {});
  try {
    if (await dispatchReview({ action: decision, change_id: id })) {
      sent[id] = decision; lsSet(LS.sent, sent);
      toast("Отправлено. Изменение применится через ~1 минуту.");
      render();
      return;
    }
  } catch (err) { toast("Ошибка: " + err.message, 6000); return; }
  // Без токена: копируем ID и открываем страницу workflow
  try { await navigator.clipboard.writeText(id); } catch { /* нет доступа к буферу */ }
  const url = actionsUrl();
  toast(`ID ${id} скопирован. В GitHub: Run workflow → action=${decision}, change_id=${id}`, 8000);
  if (url) window.open(url, "_blank", "noopener");
}

async function onCheck(programId, itemId, done) {
  const all = lsGet(LS.checklist, {});
  all[programId] = { ...(all[programId] || {}), [itemId]: done };
  lsSet(LS.checklist, all);
  render();
  try {
    if (await dispatchReview({ action: "checklist", program_id: programId, item_id: itemId, done: String(done) })) {
      toast("Сохранено в репозиторий");
    }
  } catch (err) { toast("Сохранено только на устройстве: " + err.message, 6000); }
}

document.addEventListener("click", (ev) => {
  const t = ev.target.closest("button");
  if (!t) return;
  if (t.dataset.filter) { state.filter = t.dataset.filter; render(); }
  else if (t.dataset.logfilter) { state.logFilter = t.dataset.logfilter; render(); }
  else if (t.dataset.review) {
    const verb = t.dataset.review === "approve" ? "Подтвердить" : "Отклонить";
    if (confirm(`${verb} изменение ${t.dataset.id}?`)) onReview(t.dataset.review, t.dataset.id);
  }
  else if (t.id === "s-save") {
    lsSet(LS.settings, {
      ...lsGet(LS.settings, {}),
      owner: $("#s-owner").value.trim(), repo: $("#s-repo").value.trim(),
      branch: $("#s-branch").value.trim(), token: $("#s-token").value.trim(),
    });
    toast("Сохранено"); render();
  }
  else if (t.id === "ics-copy") {
    navigator.clipboard?.writeText($("#ics-url").value).then(() => toast("Адрес скопирован"), () => toast("Не удалось скопировать"));
  }
  else if (t.id === "s-ai-save") {
    lsSet(LS.settings, { ...lsGet(LS.settings, {}), gemini: $("#s-gemini").value.trim(), model: $("#s-model").value.trim() });
    toast("Сохранено"); render();
  }
  else if (t.id === "pf-save") {
    const pr = {};
    for (const f of PROFILE_FIELDS) { const v = $(`#pf-${f.key}`).value.trim(); if (v !== "") pr[f.key] = v; }
    lsSet(LS.profile, pr); toast("Профиль сохранён"); render();
  }
  else if (t.id === "pf-export") {
    navigator.clipboard?.writeText(JSON.stringify(profile(), null, 2)).then(() => toast("Скопировано"), () => toast("Не удалось скопировать"));
  }
  else if (t.dataset.stage) setStatus(t.dataset.program, { stage: t.dataset.stage });
  else if (t.dataset.outcome) setStatus(t.dataset.program, { outcome: t.dataset.outcome });
  else if (t.dataset.chat) openChat(t.dataset.chat);
  else if (t.id === "chat-close") closeChat();
  else if (t.id === "chat-clear") { chatHistory(chat.pid, []); renderChat(); }
  else if (t.id === "s-export") {
    const data = state.programs.map((p) => ({ id: p.id, documents_checklist: checklist(p) }));
    navigator.clipboard?.writeText(JSON.stringify(data, null, 2)).then(() => toast("Скопировано"), () => toast("Не удалось скопировать"));
  }
  else if (t.id === "s-reset" && confirm("Сбросить локальные отметки чек-листов?")) {
    lsSet(LS.checklist, {}); render();
  }
});

document.addEventListener("change", (ev) => {
  const el = ev.target;
  if (el.matches("input[data-check]")) onCheck(el.dataset.program, el.dataset.check, el.checked);
  if (el.id === "status-note") setStatus(el.dataset.program, { note: el.value.trim() });
});

window.addEventListener("hashchange", () => { closeChat(); render(); window.scrollTo(0, 0); });

/* ---------- чат по программе ---------- */
const chat = { pid: null, busy: false };
const CHAT_SYSTEM = `Ты — помощник абитуриента из Кыргызстана, который поступает на бакалавриат (Computer Science или Social Studies).
Отвечай по-русски, коротко и по делу.
Главный источник — ДАННЫЕ ТРЕКЕРА и ТЕКСТЫ ОФИЦИАЛЬНЫХ СТРАНИЦ ниже. Если берёшь из них факт — укажи ссылку на источник.
Если ответа в них нет — прямо скажи «в данных трекера этого нет» и подскажи, где проверить (официальный сайт, посольство, приёмная комиссия).
Общие знания можно использовать, но помечай их «(общая информация — проверьте на официальном сайте)».
Никогда не выдумывай даты, суммы, минимальные баллы и списки документов.
Даты со статусом expected — это ожидание по прошлым годам, а не официальное объявление; так и говори.`;

function chatHistory(pid, value) {
  const all = lsGet(LS.chat, {});
  if (value === undefined) return all[pid] || [];
  all[pid] = value.slice(-30); lsSet(LS.chat, all); return all[pid];
}

function stripLocal(p) {
  const { documents_checklist, ...rest } = p;
  return { ...rest, documents_checklist: checklist(p).map((c) => ({ title: c.title, done: c.done, url: c.url })) };
}

async function chatContext(pid) {
  const pr = profile();
  let ctx = `ПРОФИЛЬ АБИТУРИЕНТА:\n${JSON.stringify(pr)}\n\nСЕГОДНЯ: ${ymd(new Date(), HOME_TZ)}\n\n`;
  if (pid === "all") {
    const brief = state.programs.map((p) => ({ name: p.name, country: p.country, type: p.type, deadline: p.deadline, deadline_status: p.deadline_status, requirements: p.requirements, thresholds: p.thresholds, notes: p.notes }));
    return ctx + `ДАННЫЕ ТРЕКЕРА (все программы):\n${JSON.stringify(brief)}`;
  }
  const p = programById(pid);
  ctx += `ДАННЫЕ ТРЕКЕРА:\n${JSON.stringify(stripLocal(p))}\n`;
  let budget = 24000;
  for (const src of (state.sourceList || []).filter((x) => x.program_id === pid)) {
    if (budget <= 0) break;
    try {
      const r = await fetch(`data/snapshots/${encodeURIComponent(src.id)}.txt`, { cache: "no-store" });
      if (!r.ok) continue;
      const t = (await r.text()).slice(0, Math.min(8000, budget));
      budget -= t.length;
      ctx += `\nТЕКСТ ОФИЦИАЛЬНОЙ СТРАНИЦЫ ${src.url} (снимок агента):\n<<<\n${t}\n>>>\n`;
    } catch { /* снимка нет */ }
  }
  return ctx;
}

function fmtMsg(text) {
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/(https?:\/\/[^\s<)]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
    .replace(/\n/g, "<br>");
}

function renderChat() {
  const box = $("#chat"), hist = chatHistory(chat.pid);
  const p = programById(chat.pid);
  box.querySelector(".chat-title").textContent = p ? p.name : "Вопрос по поступлению";
  const key = lsGet(LS.settings, {}).gemini;
  const log = box.querySelector(".chat-log");
  log.innerHTML = (!key
    ? `<div class="msg sys">Чтобы задавать вопросы, добавьте бесплатный ключ Gemini в <a href="#/settings">настройках</a>.</div>` : "")
    + (hist.length ? "" : `<div class="msg sys">Спросите, например: «Какие документы мне нужно перевести?» или «Хватит ли моего IELTS?». Ответы опираются на данные трекера и снимки официальных страниц.</div>`)
    + hist.map((m) => `<div class="msg ${m.role === "user" ? "me" : "bot"}">${fmtMsg(m.text)}</div>`).join("")
    + (chat.busy ? `<div class="msg bot muted">Думаю…</div>` : "");
  log.scrollTop = log.scrollHeight;
}

function openChat(pid) { chat.pid = pid; $("#chat").hidden = false; renderChat(); $("#chat-input").focus(); }
function closeChat() { $("#chat").hidden = true; }

const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";

/** Самая новая обычная Flash-модель, доступная ключу (модели регулярно снимают с поддержки). */
async function pickGeminiModel(key) {
  const r = await fetch(`${GEMINI_API}/models?pageSize=1000`, { headers: { "x-goog-api-key": key } });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `HTTP ${r.status}`);
  const names = (data.models || []).filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => m.name.split("/").pop()).filter((n) => n.includes("flash"));
  const stable = names.filter((n) => !/lite|image|tts|live|audio|thinking|exp|preview/.test(n));
  const pool = stable.length ? stable : names;
  const ver = (n) => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
  pool.sort((a, b) => ver(b) - ver(a) || a.length - b.length);
  return pool[0] || null;
}

async function sendChat(text) {
  const { gemini, model } = lsGet(LS.settings, {});
  if (!gemini) { toast("Добавьте ключ Gemini в настройках"); return; }
  const hist = chatHistory(chat.pid, [...chatHistory(chat.pid), { role: "user", text }]);
  chat.busy = true; renderChat();
  try {
    const context = await chatContext(chat.pid);
    const call = (m) => fetch(`${GEMINI_API}/models/${encodeURIComponent(m)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": gemini },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: CHAT_SYSTEM + "\n\n" + context }] },
        contents: hist.map((m) => ({ role: m.role === "user" ? "user" : "model", parts: [{ text: m.text }] })),
        generationConfig: { temperature: 0.2 },
      }),
    });
    const cached = lsGet("tracker.model", null);
    let r = await call(model || cached || "gemini-2.5-flash");
    if (r.status === 404) {  // модель сняли с поддержки — подбираем актуальную и запоминаем
      const picked = await pickGeminiModel(gemini);
      if (picked) { lsSet("tracker.model", picked); r = await call(picked); }
    }
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error?.message || `HTTP ${r.status}`);
    const answer = data.candidates?.[0]?.content?.parts?.map((x) => x.text).join("") || "Пустой ответ.";
    chatHistory(chat.pid, [...hist, { role: "model", text: answer }]);
  } catch (err) {
    chatHistory(chat.pid, [...hist, { role: "model", text: "⚠️ Ошибка: " + err.message }]);
  } finally { chat.busy = false; renderChat(); }
}

document.addEventListener("submit", (ev) => {
  if (ev.target.id !== "chat-form") return;
  ev.preventDefault();
  const inp = $("#chat-input"), text = inp.value.trim();
  if (!text || chat.busy) return;
  inp.value = ""; sendChat(text);
});
document.addEventListener("keydown", (ev) => {
  if (ev.target.id === "chat-input" && ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); $("#chat-form").requestSubmit(); }
  if (ev.key === "Escape" && !$("#chat").hidden) closeChat();
});

loadData().then(render).catch((err) => {
  $("#app").innerHTML = `<div class="card"><b>Не удалось загрузить данные.</b><p class="small muted">${esc(err.message)}</p>
    <p class="small">Если открываете файл напрямую с диска, запустите локальный сервер: <code>python -m http.server</code></p></div>`;
});
