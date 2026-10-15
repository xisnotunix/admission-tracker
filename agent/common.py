"""Общие функции: файлы данных, даты, Telegram."""
import json
import os
import re
import unicodedata
from datetime import date, datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
PROGRAMS_FILE = DATA / "programs.json"
SOURCES_FILE = DATA / "sources.json"
CHANGELOG_FILE = DATA / "changelog.json"
STATE_FILE = DATA / "state.json"
SNAPSHOTS = DATA / "snapshots"

HOME_TZ = ZoneInfo("Asia/Bishkek")


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_json(path, data):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def today_home():
    return datetime.now(HOME_TZ).date()


def program_by_id(programs, program_id):
    for p in programs["programs"]:
        if p["id"] == program_id:
            return p
    return None


# ---------- даты ----------

def deadline_datetime(deadline):
    """Момент дедлайна (aware datetime) или None, если даты нет.
    Без времени считаем конец дня 23:59 в часовом поясе дедлайна."""
    if not deadline or not deadline.get("date"):
        return None
    tz = ZoneInfo(deadline.get("timezone") or "Asia/Bishkek")
    hh, mm = (deadline.get("time") or "23:59").split(":")
    y, m, d = (int(x) for x in deadline["date"].split("-"))
    return datetime(y, m, d, int(hh), int(mm), tzinfo=tz)


def days_left(deadline, today=None):
    """Сколько календарных дней (по времени Бишкека) осталось до дедлайна."""
    dt = deadline_datetime(deadline)
    if dt is None:
        return None
    today = today or today_home()
    return (dt.astimezone(HOME_TZ).date() - today).days


def format_deadline(deadline):
    dt = deadline_datetime(deadline)
    if dt is None:
        return "дата неизвестна"
    local = dt.astimezone(HOME_TZ)
    s = dt.strftime("%d.%m.%Y")
    if deadline.get("time"):
        s += f" {deadline['time']} ({dt.tzname()}) = {local:%d.%m %H:%M} по Бишкеку"
    return s


# ---------- нормализация текста для проверки цитат ----------

_QUOTES = str.maketrans({
    "‘": "'", "’": "'", "“": '"', "”": '"', "«": '"', "»": '"',
    "–": "-", "—": "-", "−": "-", " ": " ",
})


def normalize(text):
    text = unicodedata.normalize("NFKC", text or "").translate(_QUOTES).lower()
    return re.sub(r"\s+", " ", text).strip()


def quote_in_text(quote, text):
    """Цитата засчитывается, только если она дословно (с точностью до пробелов,
    регистра и типографских кавычек) встречается в тексте страницы."""
    q = normalize(quote)
    return len(q) >= 8 and q in normalize(text)


# ---------- Telegram ----------

def send_telegram(text):
    # strip + удаление переводов строк: токен часто вставляют с лишним Enter
    token = "".join((os.environ.get("TELEGRAM_BOT_TOKEN") or "").split())
    chat_id = (os.environ.get("TELEGRAM_CHAT_ID") or "").strip()
    if not token or not chat_id:
        print("[telegram] секреты не заданы, сообщение не отправлено:\n" + text)
        return False
    r = requests.post(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data={
            "chat_id": chat_id,
            "text": text[:4000],
            "parse_mode": "HTML",
            "disable_web_page_preview": "true",
        },
        timeout=30,
    )
    if not r.ok:
        print(f"[telegram] ошибка {r.status_code}: {r.text[:300]}")
    return r.ok


def html_escape(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def site_url():
    """Адрес приложения на GitHub Pages (для ссылок в сообщениях)."""
    repo = os.environ.get("GITHUB_REPOSITORY")  # owner/name
    if not repo:
        return None
    owner, name = repo.split("/", 1)
    return f"https://{owner.lower()}.github.io/{name}/"
