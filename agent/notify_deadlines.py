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
    PROGRAMS_FILE, days_left, format_deadline, html_escape, load_json, send_telegram, site_url,
)

REMIND_DAYS = (60, 30, 14, 7, 1)
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
        msg = (
            f"⏰ <b>{html_escape(p['name'])}</b>: до дедлайна {n} {word}\n"
            f"Дедлайн: {html_escape(format_deadline(p['deadline']))}\n"
            f"Статус: {STATUS_LABELS.get(p.get('deadline_status'), p.get('deadline_status'))}"
        )
        if todo:
            msg += f"\nНе готово документов: {len(todo)} из {len(checklist)}"
            msg += "".join(f"\n • {html_escape(t)}" for t in todo[:8])
        link = site_url()
        if link:
            msg += f"\n<a href=\"{link}#/p/{p['id']}\">Открыть карточку</a>"
        out.append(msg)
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--today", help="YYYY-MM-DD, для проверки")
    args = parser.parse_args()
    today = date.fromisoformat(args.today) if args.today else None

    messages = build_messages(load_json(PROGRAMS_FILE), today)
    for m in messages:
        if args.dry_run:
            print("---\n" + m)
        else:
            send_telegram(m)
    print(f"Напоминаний: {len(messages)}")


if __name__ == "__main__":
    main()
