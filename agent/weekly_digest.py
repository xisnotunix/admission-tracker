"""Еженедельная сводка в Telegram (понедельник, 09:00 по Бишкеку).

Запуск: python agent/weekly_digest.py [--dry-run] [--today 2026-11-16]
Чек-лист берётся из programs.json: отметки, сделанные только в браузере (без токена), агенту не видны.
"""
import argparse
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (  # noqa: E402
    CHANGELOG_FILE, HOME_TZ, PROGRAMS_FILE, STATE_FILE, days_left, format_deadline, html_escape,
    load_json, send_telegram, site_url,
)

STATUS = {"confirmed": "✅", "expected": "🟡", "unknown": "⚪"}
STAGES = {"preparing": "🛠 готовлю", "submitted": "📨 подано", "interview": "🎤 экзамен/интервью"}


def word_days(n):
    if n % 10 == 1 and n % 100 != 11:
        return "день"
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return "дня"
    return "дней"


def build_digest(programs, changelog, state, today=None, limit=5):
    today = today or datetime.now(HOME_TZ).date()
    upcoming = []
    for p in programs["programs"]:
        if (p.get("application_status") or {}).get("stage") == "result":
            continue
        n = days_left(p.get("deadline"), today)
        if n is not None and n >= 0:
            upcoming.append((n, p))
    upcoming.sort(key=lambda x: x[0])

    lines = [f"📋 <b>Сводка на неделю</b> ({today:%d.%m.%Y})", ""]
    if upcoming:
        lines.append("<b>Ближайшие дедлайны:</b>")
        for n, p in upcoming[:limit]:
            cl = p.get("documents_checklist") or []
            todo = sum(1 for c in cl if not c.get("done"))
            stage = STAGES.get((p.get("application_status") or {}).get("stage"), "")
            line = (f"{STATUS.get(p.get('deadline_status'), '⚪')} {html_escape(p['name'])} — "
                    f"<b>{n} {word_days(n)}</b> ({html_escape(format_deadline(p['deadline']))})")
            extra = [x for x in (stage, f"не готово документов: {todo} из {len(cl)}" if cl and todo else "") if x]
            if extra:
                line += "\n    " + "; ".join(extra)
            lines.append(line)
    else:
        lines.append("Ближайших дедлайнов с известной датой нет.")

    week_ago = (today - timedelta(days=7)).isoformat()
    entries = changelog.get("entries", [])
    pending = [e for e in entries if e.get("status") == "pending"]
    new_programs = [e for e in entries if e.get("kind") == "new_program" and (e.get("created") or "") >= week_ago]
    changed_pages = [e for e in entries if e.get("kind") == "page" and e.get("summary") != "Первый снимок страницы"
                     and (e.get("created") or "") >= week_ago]
    errors = [sid for sid, s in state.get("sources", {}).items() if s.get("error")]

    lines.append("")
    lines.append(f"⚑ Ждут проверки в журнале: <b>{len(pending)}</b>" if pending else "⚑ В журнале ничего не ждёт проверки.")
    if new_programs:
        lines.append("🆕 Новые программы за неделю: " + ", ".join(html_escape(e["new"]["name"]) for e in new_programs))
    if changed_pages:
        lines.append(f"🔄 Изменилось официальных страниц за неделю: {len(changed_pages)}")
    if errors:
        lines.append("❗ Не открываются источники: " + ", ".join(html_escape(e) for e in errors))
    if state.get("llm_ok") is False:
        lines.append("❗ LLM недавно не отвечала — часть страниц ещё не разобрана.")
    lines.append("<i>🟡 — дата ожидается по прошлым годам, ✅ — подтверждена.</i>")
    link = site_url()
    if link:
        lines.append(f'<a href="{link}">Открыть трекер</a>')
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--today", help="YYYY-MM-DD, для проверки")
    args = parser.parse_args()
    today = date.fromisoformat(args.today) if args.today else None
    text = build_digest(load_json(PROGRAMS_FILE), load_json(CHANGELOG_FILE), load_json(STATE_FILE), today)
    if args.dry_run:
        print(text)
    else:
        send_telegram(text)
        print("Сводка отправлена")


if __name__ == "__main__":
    main()
