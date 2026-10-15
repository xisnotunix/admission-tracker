"""Календарь дедлайнов в формате iCalendar (data/deadlines.ics).

На него можно подписаться по URL GitHub Pages (Google Календарь → «Добавить по URL»),
и календарь будет обновляться сам. Запуск вручную: python agent/calendar_ics.py
"""
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, PROGRAMS_FILE, deadline_datetime, format_deadline, load_json, site_url  # noqa: E402

ICS_FILE = DATA / "deadlines.ics"
STATUS = {"confirmed": "подтверждён", "expected": "ожидается (по прошлым годам)", "unknown": "не проверено"}


def _escape(text):
    return (str(text).replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n"))


def _fold(line):
    """Строки iCalendar — не длиннее 75 байт, перенос с пробелом в начале."""
    out, cur = [], b""
    for ch in line:
        b = ch.encode("utf-8")
        if len(cur) + len(b) > 74:
            out.append(cur.decode("utf-8"))
            cur = b" "
        cur += b
    out.append(cur.decode("utf-8"))
    return "\r\n".join(out)


def build_ics(programs, now=None):
    now = now or datetime.now(timezone.utc)
    stamp = now.strftime("%Y%m%dT%H%M%SZ")
    link = site_url()
    lines = [
        "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//admission-tracker//RU", "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH", "X-WR-CALNAME:Дедлайны поступления", "X-WR-TIMEZONE:Asia/Bishkek",
    ]
    for p in programs["programs"]:
        dl = p.get("deadline") or {}
        if not dl.get("date"):
            continue
        status = p.get("deadline_status", "unknown")
        title = f"Дедлайн: {p['name']}" + (" (ожидается)" if status != "confirmed" else "")
        desc = [f"Статус даты: {STATUS.get(status, status)}", f"Дедлайн: {format_deadline(dl)}"]
        if dl.get("note"):
            desc.append(dl["note"])
        if link:
            desc.append(f"{link}#/p/{p['id']}")
        lines += ["BEGIN:VEVENT", f"UID:{p['id']}-deadline@admission-tracker", f"DTSTAMP:{stamp}"]
        if dl.get("time"):
            start = deadline_datetime(dl).astimezone(timezone.utc)
            lines += [f"DTSTART:{start:%Y%m%dT%H%M%SZ}", "DURATION:PT1H"]
        else:
            day = datetime.strptime(dl["date"], "%Y-%m-%d").date()
            lines += [f"DTSTART;VALUE=DATE:{day:%Y%m%d}", f"DTEND;VALUE=DATE:{day + timedelta(days=1):%Y%m%d}"]
        lines += [f"SUMMARY:{_escape(title)}", f"DESCRIPTION:{_escape(chr(10).join(desc))}"]
        if dl.get("source_url"):
            lines.append(f"URL:{dl['source_url']}")
        for days in (7, 1):
            lines += ["BEGIN:VALARM", "ACTION:DISPLAY", f"DESCRIPTION:{_escape(title)}", f"TRIGGER:-P{days}D", "END:VALARM"]
        lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")
    return "\r\n".join(_fold(line) for line in lines) + "\r\n"


def write_ics(programs=None):
    programs = programs or load_json(PROGRAMS_FILE)
    ICS_FILE.write_text(build_ics(programs), encoding="utf-8", newline="")
    return ICS_FILE


if __name__ == "__main__":
    print(write_ics())
