"""Ежедневные напоминания в Telegram за 60, 30, 14, 7 и 1 день до дедлайна.

Запуск: python agent/notify_deadlines.py [--dry-run] [--today 2026-11-16]
Workflow запускается раз в день, поэтому каждое напоминание приходит один раз.
"""
import argparse
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (  # noqa: E402
    PROGRAMS_FILE, days_left, format_deadline, format_deadline_home, html_escape, load_events, load_json,
    plural_days, send_telegram, site_url,
)

REMIND_DAYS = (60, 30, 14, 7, 1)
EVENT_REMIND_DAYS = (30, 14, 7, 3, 1)
STATUS_LABELS = {
    "confirmed": "✅ подтверждён",
    "expected": "🟡 ожидается (не подтверждён)",
    "unknown": "⚪ не проверен",
}


def build_messages(programs, today=None):
    out = []
    for p in programs["programs"]:
        n = days_left(p.get("deadline"), today)
        if n not in REMIND_DAYS:
            continue
        checklist = p.get("documents_checklist") or []
        todo = [c["title"] for c in checklist if not c.get("done")]
        word = "день" if n == 1 else "дней"
        home = format_deadline_home(p["deadline"])
        msg = (
            f"⏰ <b>{html_escape(p['name'])}</b>: до дедлайна {n} {word}\n"
            f"Дедлайн: {html_escape(format_deadline(p['deadline']))}\n"
            + (f"По Бишкеку: {home}\n" if home else "")
            + f"Статус: {STATUS_LABELS.get(p.get('deadline_status'), p.get('deadline_status'))}"
        )
        if todo:
            msg += f"\nНе готово документов: {len(todo)} из {len(checklist)}"
            msg += "".join(f"\n • {html_escape(t)}" for t in todo[:8])
        link = site_url()
        if link:
            msg += f"\n<a href=\"{link}#/p/{p['id']}\">Открыть карточку</a>"
        out.append(msg)
    return out


def build_event_messages(events, today=None):
    """Напоминания о регистрации на экзамен и о самом экзамене."""
    out = []
    for e in events:
        reg = e.get("registration") or {}
        checks = [("регистрации", reg)] if reg.get("date") else []
        if e.get("date"):
            checks.append(("экзамена", {"date": e["date"], "time": None, "timezone": "Asia/Bishkek"}))
        for what, when in checks:
            n = days_left(when, today)
            if n not in EVENT_REMIND_DAYS:
                continue
            status = "" if e.get("status") == "confirmed" else " (дата ожидается, не подтверждена)"
            msg = (f"📝 <b>{html_escape(e['name'])}</b>: до {what} {n} {plural_days(n)}{status}\n"
                   f"{'Регистрация до' if what == 'регистрации' else 'Экзамен'}: {html_escape(format_deadline(when))}")
            home = format_deadline_home(when)
            if home:
                msg += f"\nПо Бишкеку: {home}"
            if e.get("notes"):
                msg += f"\n{html_escape(e['notes'])}"
            if e.get("source_url"):
                msg += f"\n{html_escape(e['source_url'])}"
            out.append(msg)
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--today", help="YYYY-MM-DD, для проверки")
    args = parser.parse_args()
    today = date.fromisoformat(args.today) if args.today else None

    messages = build_messages(load_json(PROGRAMS_FILE), today) + build_event_messages(load_events(), today)
    for m in messages:
        if args.dry_run:
            print("---\n" + m)
        else:
            send_telegram(m)
    print(f"Напоминаний: {len(messages)}")


if __name__ == "__main__":
    main()
