"""Ручное подтверждение изменений (запускается из workflow "Review change").

  python agent/review.py approve 2026-11-03-002
  python agent/review.py reject  2026-11-03-002
  python agent/review.py checklist stipendium-hungaricum transcript true

approve — переносит предложенное значение в programs.json (с source_url и цитатой),
для дедлайна ставит deadline_status=confirmed (цитата с официальной страницы + ваша проверка).
Для новой программы (kind=new_program) — добавляет её в programs.json с пустыми полями,
а её ссылку — в белый список sources.json (агент начнёт проверять её со следующего запуска).
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (  # noqa: E402
    CHANGELOG_FILE, PROGRAMS_FILE, SOURCES_FILE, load_json, now_iso, program_by_id, save_json,
)


def apply_change(program, entry):
    field, new = entry["field"], entry["new"]
    stamp = now_iso()
    if field == "deadline":
        program["deadline"] = {
            "date": new["date"], "time": new.get("time"),
            "timezone": new.get("timezone") or (program.get("deadline") or {}).get("timezone"),
            "source_url": new["source_url"], "quote": new["quote"],
        }
        program["deadline_status"] = "confirmed"
    elif field == "opens":
        program["opens"] = {
            "date": new["date"], "time": None, "timezone": None, "text": None,
            "status": "confirmed", "source_url": new["source_url"], "quote": new["quote"],
        }
    elif field.startswith("requirements."):
        key = field.split(".", 1)[1]
        program.setdefault("requirements", {})[key] = {
            "value": new["value"], "source_url": new["source_url"], "quote": new["quote"],
        }
    else:
        raise SystemExit(f"Неизвестное поле: {field}")
    program["last_changed"] = stamp


def slugify(name, taken):
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40] or "program"
    slug, n = base, 2
    while slug in taken:
        slug, n = f"{base}-{n}", n + 1
    return slug


def add_program(programs, entry):
    new = entry["new"]
    pid = slugify(new["name"], {p["id"] for p in programs["programs"]})
    empty = {"value": None, "source_url": None, "quote": None}
    url = new.get("url") or entry["source_url"]
    programs["programs"].append({
        "id": pid, "name": new["name"], "country": new.get("country") or "—", "type": "стипендия",
        "priority": "medium", "official_urls": [url],
        "nominating_body": dict(empty),
        "opens": {"date": None, "time": None, "timezone": None, "text": None, "status": "unknown", "source_url": None, "quote": None},
        "deadline": {"date": None, "time": None, "timezone": "Asia/Bishkek", "source_url": entry["source_url"],
                     "quote": None, "note": new.get("deadline_text")},
        "deadline_status": "unknown",
        "requirements": {k: dict(empty) for k in ("language", "exams", "documents", "min_grades")},
        "documents_checklist": [], "files": [],
        "last_checked": None, "last_changed": now_iso(), "reviewed": None,
        "notes": f"Найдено агентом на {entry['source_url']}: «{new['quote']}»",
    })
    if new.get("url"):
        sources = load_json(SOURCES_FILE)
        if not any(s["url"] == new["url"] for s in sources["sources"]):
            sources["sources"].append({"id": pid, "kind": "page", "program_id": pid, "url": new["url"],
                                       "selector": None, "enabled": True})
            save_json(SOURCES_FILE, sources)
    entry["program_id"] = pid
    return pid


def resolve(decision, change_id):
    programs, changelog = load_json(PROGRAMS_FILE), load_json(CHANGELOG_FILE)
    entry = next((e for e in changelog["entries"] if e["id"] == change_id), None)
    if entry is None:
        raise SystemExit(f"Изменение {change_id} не найдено")
    if entry.get("status") != "pending":
        raise SystemExit(f"Изменение {change_id} уже в статусе {entry.get('status')}")
    if decision == "approve" and entry.get("kind") == "new_program":
        print("добавлена программа", add_program(programs, entry))
        save_json(PROGRAMS_FILE, programs)
    elif decision == "approve":
        program = program_by_id(programs, entry["program_id"])
        if program is None:
            raise SystemExit(f"Программа {entry['program_id']} не найдена")
        apply_change(program, entry)
        save_json(PROGRAMS_FILE, programs)
    entry["status"] = "approved" if decision == "approve" else "rejected"
    entry["resolved"] = now_iso()
    save_json(CHANGELOG_FILE, changelog)
    print(f"{change_id}: {entry['status']}")


def set_checklist(program_id, item_id, done):
    programs = load_json(PROGRAMS_FILE)
    program = program_by_id(programs, program_id)
    if program is None:
        raise SystemExit(f"Программа {program_id} не найдена")
    item = next((c for c in program.get("documents_checklist", []) if c["id"] == item_id), None)
    if item is None:
        raise SystemExit(f"Пункт {item_id} не найден")
    item["done"] = done
    save_json(PROGRAMS_FILE, programs)
    print(f"{program_id}/{item_id}: done={done}")


def main(argv):
    if len(argv) >= 2 and argv[0] in ("approve", "reject"):
        resolve(argv[0], argv[1])
    elif len(argv) == 4 and argv[0] == "checklist":
        set_checklist(argv[1], argv[2], argv[3].lower() in ("true", "1", "yes", "да"))
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
