"""Агент проверки официальных страниц.

Алгоритм для каждого источника из белого списка data/sources.json:
  1. скачать страницу (редиректы — только внутри белого списка доменов);
  2. вытащить текст, посчитать sha256;
  3. хеш не изменился -> только отметка last_checked, больше ничего;
  4. хеш изменился -> снимок текста, запись в журнал, запрос к LLM,
     проверка цитат, предложения изменений со статусом "pending".

Агент НИКОГДА не меняет данные программ сам — только журнал (data/changelog.json),
служебное состояние (data/state.json), снимки и метки last_checked/last_changed.
Подтверждение — вручную через workflow "Review change" (agent/review.py).

Запуск:
  python agent/check_sources.py                    # все включённые источники
  python agent/check_sources.py --source sh-main   # один источник
  python agent/check_sources.py --source sh-main --dry-run   # ничего не записывать
  python agent/check_sources.py --force            # вызвать LLM даже без изменений
"""
import argparse
import difflib
import hashlib
import sys
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))
from common import (  # noqa: E402
    CHANGELOG_FILE, PROGRAMS_FILE, SNAPSHOTS, SOURCES_FILE, STATE_FILE,
    html_escape, load_json, normalize, now_iso, program_by_id, quote_in_text,
    save_json, send_telegram, site_url,
)
import llm  # noqa: E402

USER_AGENT = "AdmissionTrackerBot/1.0 (personal deadline tracker; weekly check)"
MAX_REDIRECTS = 5
REQUIREMENT_KEYS = ["language", "exams", "documents", "min_grades"]
REQUIREMENT_LABELS = {
    "language": "язык", "exams": "экзамены", "documents": "документы", "min_grades": "мин. оценки",
}
TZ_ALIASES = {
    "CET": "Europe/Budapest", "CEST": "Europe/Budapest",
    "JST": "Asia/Tokyo", "KGT": "Asia/Bishkek", "BISHKEK": "Asia/Bishkek",
    "UTC": "UTC", "GMT": "UTC",
}


# ---------- загрузка и текст ----------

def host(url):
    h = (urlparse(url).hostname or "").lower()
    return h[4:] if h.startswith("www.") else h


def fetch(url, allowed_hosts):
    """GET с ручной обработкой редиректов: уходить за пределы белого списка нельзя."""
    for _ in range(MAX_REDIRECTS + 1):
        if host(url) not in allowed_hosts:
            raise RuntimeError(f"редирект за пределы белого списка: {url}")
        r = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=45, allow_redirects=False)
        if r.is_redirect or r.status_code in (301, 302, 303, 307, 308):
            url = urljoin(url, r.headers.get("Location", ""))
            continue
        r.raise_for_status()
        r.encoding = r.encoding if r.encoding and r.encoding.lower() != "iso-8859-1" else r.apparent_encoding
        return r.text
    raise RuntimeError("слишком много редиректов")


def extract_text(html, selector=None):
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "noscript", "svg", "iframe", "nav", "footer", "form", "template"]):
        tag.decompose()
    root = soup
    if selector:
        found = soup.select_one(selector)
        if found is None:
            raise RuntimeError(f"селектор {selector!r} не найден на странице")
        root = found
    lines = []
    for line in root.get_text("\n").split("\n"):
        line = " ".join(line.split())
        if line:
            lines.append(line)
    return "\n".join(lines)


def sha256(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def diff_summary(old, new, limit=12):
    """Коротко: какие строки появились и какие исчезли."""
    old_lines, new_lines = old.split("\n"), new.split("\n")
    added, removed = [], []
    for line in difflib.ndiff(old_lines, new_lines):
        if line.startswith("+ "):
            added.append(line[2:][:200])
        elif line.startswith("- "):
            removed.append(line[2:][:200])
    return {
        "added": added[:limit], "removed": removed[:limit],
        "added_total": len(added), "removed_total": len(removed),
    }


# ---------- проверка ответа LLM ----------

def clean_value(v):
    if v is None:
        return None
    if isinstance(v, str):
        v = v.strip()
        return v if v and v.lower() not in ("null", "none", "n/a") else None
    return v


def verify(extracted, text):
    """Оставить только поля, у которых есть цитата, дословно найденная на странице."""
    result, dropped = {}, []

    def ok(field, quote):
        if not quote:
            return False
        if not quote_in_text(quote, text):
            dropped.append(field)
            return False
        return True

    d = (extracted or {}).get("deadline") or {}
    if clean_value(d.get("date")) and ok("deadline", d.get("quote")):
        tz_raw = clean_value(d.get("timezone"))
        result["deadline"] = {
            "date": clean_value(d.get("date")),
            "time": clean_value(d.get("time")),
            "timezone": TZ_ALIASES.get((tz_raw or "").upper(), tz_raw if tz_raw and "/" in tz_raw else None),
            "timezone_raw": tz_raw,
            "quote": d["quote"].strip(),
        }

    o = (extracted or {}).get("opens") or {}
    if clean_value(o.get("date")) and ok("opens", o.get("quote")):
        result["opens"] = {"date": clean_value(o.get("date")), "quote": o["quote"].strip()}

    reqs = (extracted or {}).get("requirements") or {}
    for key in REQUIREMENT_KEYS:
        item = reqs.get(key) or {}
        if clean_value(item.get("value")) and ok(key, item.get("quote")):
            result[key] = {"value": clean_value(item["value"]), "quote": item["quote"].strip()}
    return result, dropped


# ---------- предложения изменений ----------

def proposals(program, verified, source_url):
    """Сравнить проверенные данные с текущими и вернуть список предложений."""
    out = []
    if "deadline" in verified:
        new = verified["deadline"]
        old = program.get("deadline") or {}
        same = (new["date"], new["time"], new["timezone"]) == (old.get("date"), old.get("time"), old.get("timezone"))
        if not same or program.get("deadline_status") != "confirmed":
            out.append(("deadline", {k: old.get(k) for k in ("date", "time", "timezone")} | {
                "status": program.get("deadline_status")}, new))
    if "opens" in verified:
        new = verified["opens"]
        old = program.get("opens") or {}
        if new["date"] != old.get("date"):
            out.append(("opens", {"date": old.get("date"), "text": old.get("text")}, new))
    for key in REQUIREMENT_KEYS:
        if key not in verified:
            continue
        new = verified[key]
        old = (program.get("requirements") or {}).get(key) or {}
        if old.get("value") is None or normalize(old.get("quote")) != normalize(new["quote"]):
            out.append((f"requirements.{key}", {"value": old.get("value")}, new))
    for field, old, new in out:
        new["source_url"] = source_url
    return out


def already_pending(changelog, program_id, field, new):
    for e in changelog["entries"]:
        if (e.get("status") == "pending" and e.get("program_id") == program_id
                and e.get("field") == field and e.get("new") == new):
            return True
    return False


def next_id(changelog, stamp):
    base = stamp[:10]
    n = sum(1 for e in changelog["entries"] if e["id"].startswith(base)) + 1
    return f"{base}-{n:03d}"


# ---------- основной цикл ----------

def check_source(src, ctx, args):
    programs, changelog, state = ctx["programs"], ctx["changelog"], ctx["state"]
    program = program_by_id(programs, src["program_id"])
    if program is None:
        raise RuntimeError(f"программа {src['program_id']} не найдена в programs.json")

    stamp = now_iso()
    st = state["sources"].setdefault(src["id"], {})
    html = fetch(src["url"], ctx["allowed_hosts"])
    text = extract_text(html, src.get("selector"))
    digest = sha256(text)
    print(f"[{src['id']}] {len(text)} символов, sha256={digest[:12]}…")

    st.update({"url": src["url"], "last_checked": stamp, "error": None, "errors_in_row": 0})
    program["last_checked"] = stamp
    messages = []

    first_run = not st.get("hash")
    changed = st.get("hash") != digest
    if not changed and not args.force:
        print(f"[{src['id']}] без изменений")
        return messages

    snapshot = SNAPSHOTS / f"{src['id']}.txt"
    old_text = snapshot.read_text(encoding="utf-8") if snapshot.exists() else ""
    if changed:
        entry = {
            "id": next_id(changelog, stamp), "created": stamp, "kind": "page",
            "program_id": program["id"], "source_id": src["id"], "source_url": src["url"],
            "status": "info",
            "summary": "Первый снимок страницы" if first_run else "Текст страницы изменился",
            "diff": None if first_run else diff_summary(old_text, text),
        }
        changelog["entries"].append(entry)
        st.update({"hash": digest, "last_changed": stamp})
        if not first_run:
            program["last_changed"] = stamp
            d = entry["diff"]
            messages.append(
                f"🔄 <b>{html_escape(program['name'])}</b>: изменилась страница\n{html_escape(src['url'])}\n"
                f"+{d['added_total']} / −{d['removed_total']} строк"
            )
        if not args.dry_run:
            snapshot.write_text(text, encoding="utf-8", newline="\n")

    extracted = llm.extract(program, src["url"], text)
    if extracted is None:
        return messages
    verified, dropped = verify(extracted, text)
    if dropped:
        print(f"[{src['id']}] отброшено (цитата не найдена на странице): {', '.join(dropped)}")
    print(f"[{src['id']}] подтверждено цитатами: {', '.join(verified) or 'ничего'}")

    for field, old, new in proposals(program, verified, src["url"]):
        if already_pending(changelog, program["id"], field, new):
            continue
        changelog["entries"].append({
            "id": next_id(changelog, stamp), "created": stamp, "kind": "field",
            "program_id": program["id"], "source_id": src["id"], "source_url": src["url"],
            "field": field, "old": old, "new": new, "quote": new["quote"],
            "status": "pending", "resolved": None,
        })
        label = REQUIREMENT_LABELS.get(field.split(".")[-1], field)
        shown = new.get("date") or new.get("value")
        messages.append(
            f"⚠️ <b>{html_escape(program['name'])}</b>: новое значение «{html_escape(label)}» — "
            f"<b>{html_escape(shown)}</b>\n«{html_escape(new['quote'][:200])}»\nТребует проверки."
        )
    return messages


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", help="id источника из sources.json")
    parser.add_argument("--dry-run", action="store_true", help="ничего не записывать и не отправлять")
    parser.add_argument("--force", action="store_true", help="вызывать LLM даже если хеш не изменился")
    args = parser.parse_args()

    sources = [s for s in load_json(SOURCES_FILE)["sources"] if s.get("enabled") and s.get("url")]
    allowed_hosts = {host(s["url"]) for s in sources}
    if args.source:
        sources = [s for s in sources if s["id"] == args.source]
        if not sources:
            sys.exit(f"Источник {args.source!r} не найден или выключен в sources.json")

    ctx = {
        "programs": load_json(PROGRAMS_FILE),
        "changelog": load_json(CHANGELOG_FILE),
        "state": load_json(STATE_FILE),
        "allowed_hosts": allowed_hosts,
    }
    messages, failures = [], 0
    for src in sources:
        try:
            messages += check_source(src, ctx, args)
        except Exception as exc:  # одна сломанная страница не должна останавливать остальные
            failures += 1
            print(f"[{src['id']}] ОШИБКА: {exc}")
            st = ctx["state"]["sources"].setdefault(src["id"], {})
            st.update({"url": src["url"], "last_error_at": now_iso(), "error": str(exc)[:300]})
            st["errors_in_row"] = st.get("errors_in_row", 0) + 1
            if st["errors_in_row"] == 3:  # не спамим: сообщаем один раз после 3 неудач подряд
                messages.append(f"❗ Источник {src['id']} не открывается 3 проверки подряд: {html_escape(str(exc)[:200])}")

    if args.dry_run:
        print("[dry-run] файлы не изменены, Telegram не отправлялся")
        for m in messages:
            print("---\n" + m)
        return

    save_json(PROGRAMS_FILE, ctx["programs"])
    save_json(CHANGELOG_FILE, ctx["changelog"])
    save_json(STATE_FILE, ctx["state"])
    if messages:
        link = site_url()
        send_telegram("\n\n".join(messages) + (f"\n\n<a href=\"{link}#/log\">Открыть журнал</a>" if link else ""))
    print(f"Готово: источников {len(sources)}, ошибок {failures}, уведомлений {len(messages)}")


if __name__ == "__main__":
    main()
