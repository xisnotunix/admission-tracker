/* Трекер поступления — статическое приложение без сборки.
   Данные: data/programs.json, data/changelog.json, data/state.json (из репозитория).
   Локально (localStorage): отметки чек-листа и настройки GitHub. */
"use strict";

const HOME_TZ = "Asia/Bishkek";
const LS = { checklist: "tracker.checklist", settings: "tracker.settings", sent: "tracker.sent" };
const STATUS = {
  confirmed: { label: "подтверждён", cls: "confirmed", icon: "✓" },
  expected: { label: "ожидается", cls: "expected", icon: "~" },
  unknown: { label: "не проверено", cls: "unknown", icon: "?" },
};
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

function fmtDeadline(dl) {
  const d = deadlineDate(dl);
  if (!d) return "дата неизвестна";
  const tz = dl.timezone || HOME_TZ;
  const day = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: tz }).format(d);
  if (!dl.time) return day;
  const tzName = new Intl.DateTimeFormat("ru-RU", { timeZone: tz, timeZoneName: "short" })
    .formatToParts(d).find((p) => p.type === "timeZoneName")?.value || tz;
  let s = `${day}, ${dl.time} (${tzName})`;
  if (tz !== HOME_TZ) {
    s += ` — ${new Intl.DateTimeFormat("ru-RU", { timeZone: HOME_TZ, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(d)} по Бишкеку`;
  }
  return s;
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
  state.whitelist = (src.sources || []).filter((s) => s.enabled && s.url).map((s) => s.url);
  state.programs = programs.programs;
  state.changelog = changelog.entries || [];
  state.sources = st.sources || {};
  state.loadedAt = new Date();
}

const programById = (id) => state.programs.find((p) => p.id === id);
const pendingFor = (pid) => state.changelog.filter((e) => e.status === "pending" && (!pid || e.program_id === pid));
const sourceErrors = (p) => Object.values(state.sources).filter((s) => s.error && (p.official_urls || []).includes(s.url));

/** Чек-лист с учётом локальных отметок поверх данных репозитория. */
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
  const filters = [["all", "Все"], ["стипендия", "Стипендии"], ["вуз", "Вузы"]];
  const list = state.programs
    .filter((p) => state.filter === "all" || p.type === state.filter)
    .map((p) => ({ p, n: deadlineDate(p.deadline) }))
    .sort((a, b) => {
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
          ${pend ? `<span class="badge review">⚑ требует проверки</span>` : ""}
          ${errs ? `<span class="badge error">ошибка источника</span>` : ""}
          ${p.priority === "low" ? `<span class="badge plain">низкий приоритет</span>` : ""}
          ${cl.length ? `<span class="muted small">документы ${done}/${cl.length}</span>` : ""}
        </div>
        ${cl.length ? `<div class="progress"><i style="width:${(done / cl.length) * 100}%"></i></div>` : ""}
      </a>`;
    }).join("") || `<p class="muted center">Нет программ</p>`}
    <p class="muted small center">Данные загружены ${fmtStamp(state.loadedAt.toISOString())}</p>`;
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
        </div>
        ${countdown(p)}
        <div class="meta">${statusBadge(p)}${pend.length ? `<a href="#/log" class="badge review">⚑ ${pend.length} на проверке</a>` : ""}</div>
      </div>
      ${p.deadline?.note ? `<p class="small muted">${esc(p.deadline.note)}</p>` : ""}
      ${quoteBlock(p.deadline)}
    </div>

    <h2>Основное</h2>
    <div class="card">
      <dl class="kv">
        <dt>Приём открывается</dt><dd>${esc(opens.date || opens.text || "неизвестно")} ${opens.status ? `<span class="badge ${STATUS[opens.status]?.cls || "unknown"}">${esc(STATUS[opens.status]?.label || opens.status)}</span>` : ""}${quoteBlock(opens)}</dd>
        <dt>Кто выдвигает</dt><dd>${p.nominating_body?.value ? esc(p.nominating_body.value) : `<span class="empty">не указано</span>`}${p.nominating_body?.note ? `<div class="small muted">${esc(p.nominating_body.note)}</div>` : ""}${quoteBlock(p.nominating_body)}</dd>
        <dt>Проверено агентом</dt><dd>${fmtStamp(p.last_checked)}</dd>
        <dt>Последнее изменение</dt><dd>${fmtStamp(p.last_changed)}</dd>
      </dl>
    </div>

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
          <span>${esc(c.title)}</span>
        </label>`).join("") : `<span class="empty">Чек-лист пуст — добавьте пункты в programs.json</span>`}
    </div>

    <h2>Официальные источники</h2>
    <div class="card">
      ${(p.official_urls || []).length ? p.official_urls.map((u) => {
        const s = Object.values(state.sources).find((x) => x.url === u);
        return `<div class="field"><a href="${esc(safeUrl(u))}" target="_blank" rel="noopener">${esc(u)}</a>
          ${s ? `<div class="small muted">проверено ${fmtStamp(s.last_checked)}${s.error ? ` · <span style="color:var(--red)">ошибка: ${esc(s.error)}</span>` : ""}</div>`
            : `<div class="small muted">${state.whitelist.includes(u) ? "в белом списке, ещё не проверялся" : "не в белом списке агента"}</div>`}</div>`;
      }).join("") : `<span class="empty">Не добавлены — внесите в programs.json и data/sources.json</span>`}
    </div>

    ${p.notes ? `<h2>Заметки</h2><div class="card">${esc(p.notes)}</div>` : ""}`;
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
  if (e.kind === "field") {
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
    <div class="head"><b>${esc(p ? p.name : e.program_id)}</b>${statusBadges[e.status] || ""}</div>
    <div class="muted small">${fmtStamp(e.created)} · ID ${esc(e.id)}${e.resolved ? ` · решено ${fmtStamp(e.resolved)}` : ""}</div>
    ${body}
  </div>`;
}

function viewLog() {
  const filters = [["pending", "Требуют проверки"], ["field", "Изменения данных"], ["all", "Всё"]];
  const list = state.changelog.filter((e) =>
    state.logFilter === "all" || (state.logFilter === "pending" ? e.status === "pending" : e.kind === "field"))
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

/* ---------- роутер и события ---------- */
function render() {
  const hash = location.hash || "#/";
  let html, tab = "home";
  if (hash.startsWith("#/p/")) html = viewProgram(decodeURIComponent(hash.slice(4)));
  else if (hash === "#/log") { html = viewLog(); tab = "log"; }
  else if (hash === "#/settings") { html = viewSettings(); tab = "settings"; }
  else html = viewHome();
  $("#app").innerHTML = html;
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
      owner: $("#s-owner").value.trim(), repo: $("#s-repo").value.trim(),
      branch: $("#s-branch").value.trim(), token: $("#s-token").value.trim(),
    });
    toast("Сохранено"); render();
  }
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
});

window.addEventListener("hashchange", () => { render(); window.scrollTo(0, 0); });

loadData().then(render).catch((err) => {
  $("#app").innerHTML = `<div class="card"><b>Не удалось загрузить данные.</b><p class="small muted">${esc(err.message)}</p>
    <p class="small">Если открываете файл напрямую с диска, запустите локальный сервер: <code>python -m http.server</code></p></div>`;
});
