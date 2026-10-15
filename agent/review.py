"""Ручное подтверждение изменений (запускается из workflow "Review change").

  python agent/review.py approve 2026-11-03-002
  python agent/review.py reject  2026-11-03-002
  python agent/review.py checklist stipendium-hungaricum transcript true

approve — переносит предложенное значение в programs.json (с source_url и цитатой),
для дедлайна ставит deadline_status=confirmed (цитата с официальной страницы + ваша проверка).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import CHANGELOG_FILE, PROGRAMS_FILE, load_json, now_iso, program_by_id, save_json  # noqa: E402


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


def resolve(decision, change_id):
    programs, changelog = load_json(PROGRAMS_FILE), load_json(CHANGELOG_FILE)
    entry = next((e for e in changelog["entries"] if e["id"] == change_id), None)
    if entry is None:
        raise SystemExit(f"Изменение {change_id} не найдено")
    if entry.get("status") != "pending":
        raise SystemExit(f"Изменение {change_id} уже в статусе {entry.get('status')}")
    if decision == "approve":
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
