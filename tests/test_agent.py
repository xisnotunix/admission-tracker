"""python -m unittest discover tests"""
import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "agent"))

from check_sources import extract_text, proposals, verify  # noqa: E402
from common import days_left, quote_in_text  # noqa: E402
from notify_deadlines import build_messages  # noqa: E402

PAGE = """Application deadline: 15 January 2027, 14:00 CET.
Applicants must provide an English language certificate (IELTS 5.5 or equivalent)."""


class AgentTests(unittest.TestCase):
    def test_quote_must_be_on_page(self):
        self.assertTrue(quote_in_text("deadline:  15 January 2027", PAGE))
        self.assertFalse(quote_in_text("deadline: 31 December 2026", PAGE))

    def test_verify_drops_invented_fields(self):
        extracted = {
            "deadline": {"date": "2027-01-15", "time": "14:00", "timezone": "CET",
                         "quote": "Application deadline: 15 January 2027, 14:00 CET"},
            "opens": {"date": "2026-11-01", "quote": "Portal opens on 1 November"},  # нет на странице
            "requirements": {"language": {"value": "IELTS 5.5", "quote": "IELTS 5.5 or equivalent"},
                             "exams": {"value": None, "quote": None}},
        }
        verified, dropped = verify(extracted, PAGE)
        self.assertEqual(verified["deadline"]["timezone"], "Europe/Budapest")
        self.assertNotIn("opens", verified)
        self.assertIn("opens", dropped)
        self.assertNotIn("exams", verified)
        self.assertEqual(verified["language"]["value"], "IELTS 5.5")

    def test_proposals_only_for_differences(self):
        program = {"deadline": {"date": "2027-01-15", "time": "14:00", "timezone": "Europe/Budapest"},
                   "deadline_status": "confirmed", "requirements": {}}
        verified, _ = verify({"deadline": {"date": "2027-01-15", "time": "14:00", "timezone": "CET",
                                           "quote": "15 January 2027, 14:00 CET"}}, PAGE)
        self.assertEqual(proposals(program, verified, "https://x"), [])
        program["deadline_status"] = "expected"
        self.assertEqual(proposals(program, verified, "https://x")[0][0], "deadline")

    def test_past_deadline_is_not_proposed(self):
        program = {"deadline": {"date": None}, "deadline_status": "unknown", "requirements": {}}
        verified = {"deadline": {"date": "2026-02-14", "time": None, "timezone": None, "quote": "q"}}
        self.assertEqual(proposals(program, verified, "https://x", today=date(2026, 10, 15)), [])
        self.assertEqual(len(proposals(program, verified, "https://x", today=date(2026, 1, 1))), 1)

    def test_extract_text_strips_scripts(self):
        text = extract_text("<html><script>var a=1</script><main><p>Hello</p>  <p>World</p></main></html>")
        self.assertEqual(text, "Hello\nWorld")

    def test_days_left_and_reminders(self):
        dl = {"date": "2027-01-15", "time": "14:00", "timezone": "Europe/Budapest"}
        self.assertEqual(days_left(dl, date(2026, 11, 16)), 60)
        programs = {"programs": [{"id": "x", "name": "X", "deadline": dl, "deadline_status": "expected",
                                  "documents_checklist": [{"id": "a", "title": "A", "done": False}]}]}
        self.assertEqual(len(build_messages(programs, date(2027, 1, 14))), 1)
        self.assertEqual(len(build_messages(programs, date(2027, 1, 13))), 0)


CATALOG_HTML = """<main><h2>Конкурсы</h2>
<p>Конкурсный отбор на обучение в Китайской Народной Республике (бакалавриат). Срок до 31 января.</p>
<a href="/contest/42">Подробнее</a></main>"""


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        from check_sources import extract_links
        self.text = extract_text(CATALOG_HTML)
        self.links = extract_links(CATALOG_HTML, "https://student.edu.gov.kg/")

    def test_links_are_absolute(self):
        self.assertIn(("Подробнее", "https://student.edu.gov.kg/contest/42"), self.links)

    def test_discovered_needs_real_quote_and_link(self):
        from check_sources import verify_discovered
        result = {"programs": [
            {"name": "Стипендия Китая", "url": "https://student.edu.gov.kg/contest/42",
             "quote": "Конкурсный отбор на обучение в Китайской Народной Республике"},
            {"name": "Выдуманная стипендия", "url": None, "quote": "Стипендия Марса для всех"},
            {"name": "Китай 2", "url": "https://evil.example/x",
             "quote": "обучение в Китайской Народной Республике (бакалавриат)"},
        ]}
        found = verify_discovered(result, self.text, self.links)
        self.assertEqual([f["name"] for f in found], ["Стипендия Китая", "Китай 2"])
        self.assertIsNone(found[1]["url"])  # ссылки нет на странице — отброшена

    def test_known_program_matching(self):
        from check_sources import known_program
        programs = {"programs": [{"name": "Stipendium Hungaricum 2027/28", "official_urls": []}]}
        self.assertIsNotNone(known_program(programs, "Stipendium Hungaricum", None))
        self.assertIsNone(known_program(programs, "Türkiye Bursları", None))

    def test_approve_new_program(self):
        import review
        programs = {"programs": [{"id": "x", "name": "X"}]}
        entry = {"source_url": "https://student.edu.gov.kg/", "new": {
            "name": "China Scholarship", "country": "Китай", "url": None,
            "deadline_text": "до 31 января", "quote": "q"}}
        pid = review.add_program(programs, entry)
        self.assertEqual(pid, "china-scholarship")
        self.assertEqual(programs["programs"][-1]["deadline_status"], "unknown")


class EventTests(unittest.TestCase):
    EVENTS = [{"id": "sat", "name": "SAT", "date": "2026-11-07", "status": "confirmed",
               "registration": {"date": "2026-10-23", "time": "23:59", "timezone": "America/New_York"}},
              {"id": "ielts", "name": "IELTS", "date": None, "registration": None, "status": "unknown"}]

    def test_event_reminders(self):
        from notify_deadlines import build_event_messages
        # 23:59 по Нью-Йорку 23.10 = 09:59 по Бишкеку 24.10 → за 7 дней это 17.10
        msgs = build_event_messages(self.EVENTS, today=date(2026, 10, 17))
        self.assertEqual(len(msgs), 1)
        self.assertIn("до регистрации 7 дней", msgs[0])
        self.assertIn("По Бишкеку: 24.10.2026, 09:59", msgs[0])
        self.assertIn("до экзамена 3 дня", build_event_messages(self.EVENTS, today=date(2026, 11, 4))[0])

    def test_events_in_calendar(self):
        from calendar_ics import build_ics
        ics = build_ics({"programs": []}, events=self.EVENTS)
        self.assertIn("UID:sat-registration@admission-tracker", ics)
        self.assertIn("UID:sat-exam@admission-tracker", ics)
        self.assertEqual(ics.count("BEGIN:VEVENT"), 2)


class DigestTests(unittest.TestCase):
    def test_build_digest(self):
        from weekly_digest import build_digest
        programs = {"programs": [
            {"id": "a", "name": "A", "deadline_status": "confirmed",
             "deadline": {"date": "2027-01-01", "time": "23:59", "timezone": "Asia/Bishkek"},
             "documents_checklist": [{"id": "x", "title": "X", "done": False}, {"id": "y", "title": "Y", "done": True}],
             "application_status": {"stage": "preparing"}},
            {"id": "b", "name": "B", "deadline": {"date": "2026-01-01"}},                       # прошёл
            {"id": "c", "name": "C", "deadline": {"date": "2027-01-02"}, "application_status": {"stage": "result"}},
        ]}
        changelog = {"entries": [
            {"kind": "new_program", "status": "pending", "created": "2026-10-14T10:00:00+00:00", "new": {"name": "Новая"}},
        ]}
        text = build_digest(programs, changelog, {"sources": {"s1": {"error": "403"}}}, today=date(2026, 10, 15))
        self.assertIn("A — <b>78 дней</b>", text)
        self.assertIn("23:59 по Бишкеку", text)
        self.assertIn("не готово документов: 1 из 2", text)
        self.assertNotIn("B —", text)
        self.assertNotIn("C —", text)
        self.assertIn("Ждут проверки в журнале: <b>1</b>", text)
        self.assertIn("Новая", text)
        self.assertIn("s1", text)


class CalendarTests(unittest.TestCase):
    def test_build_ics(self):
        from calendar_ics import build_ics
        programs = {"programs": [
            {"id": "sh", "name": "Stipendium Hungaricum, 2027", "deadline_status": "expected",
             "deadline": {"date": "2027-01-15", "time": "14:00", "timezone": "Europe/Budapest"}},
            {"id": "yale", "name": "Yale", "deadline_status": "confirmed",
             "deadline": {"date": "2027-01-02", "time": None, "timezone": "America/New_York"}},
            {"id": "x", "name": "Без даты", "deadline": {"date": None}},
        ]}
        ics = build_ics(programs)
        self.assertEqual(ics.count("BEGIN:VEVENT"), 2)
        self.assertIn("DTSTART:20270115T130000Z", ics)          # 14:00 CET = 13:00 UTC
        self.assertIn("DTSTART;VALUE=DATE:20270102", ics)
        self.assertIn("SUMMARY:Дедлайн: Stipendium Hungaricum\\, 2027 (ожидается)", ics.replace("\r\n ", ""))
        self.assertTrue(all(len(line.encode()) <= 75 for line in ics.split("\r\n")))


class StatusTests(unittest.TestCase):
    def test_set_status(self):
        import review
        saved = {}
        data = {"programs": [{"id": "mit", "name": "MIT"}]}
        orig = (review.load_json, review.save_json)
        review.load_json = lambda path: data
        review.save_json = lambda path, d: saved.update(d)
        try:
            review.set_status("mit", "result:accepted")
            st = saved["programs"][0]["application_status"]
            self.assertEqual((st["stage"], st["outcome"]), ("result", "accepted"))
            with self.assertRaises(SystemExit):
                review.set_status("mit", "won")
        finally:
            review.load_json, review.save_json = orig


class LlmRobustnessTests(unittest.TestCase):
    def test_pick_gemini_model(self):
        from llm import pick_gemini_model
        names = ["models/gemini-2.0-flash", "models/gemini-3-flash", "models/gemini-3-flash-lite",
                 "models/gemini-3-flash-preview-09", "models/gemini-3-pro", "models/gemini-3-flash-image"]
        self.assertEqual(pick_gemini_model(names), "gemini-3-flash")
        self.assertIsNone(pick_gemini_model(["models/gemini-3-pro"]))

    def test_llm_failure_is_retried_next_run(self):
        import check_sources
        from types import SimpleNamespace
        program = {"id": "p", "name": "P", "deadline": {}, "requirements": {}}
        ctx = {"programs": {"programs": [program]}, "changelog": {"entries": []},
               "state": {"sources": {}}, "allowed_hosts": {"x.test"}, "llm_errors": []}
        src = {"id": "s", "kind": "page", "program_id": "p", "url": "https://x.test/"}
        args = SimpleNamespace(force=False, dry_run=True)
        calls = []

        def broken(*a):
            calls.append(1)
            raise RuntimeError("404 model not found")

        orig_fetch, orig_extract = check_sources.fetch, check_sources.llm.extract
        check_sources.fetch = lambda url, hosts: "<p>Deadline: 15 January 2027</p>"
        check_sources.llm.extract = broken
        try:
            check_sources.check_source(src, ctx, args)
            self.assertTrue(ctx["state"]["sources"]["s"]["llm_pending"])
            # Страница та же, но прошлый вызов LLM упал — должен быть повтор.
            check_sources.check_source(src, ctx, args)
            self.assertEqual(len(calls), 2)
            check_sources.llm.extract = lambda *a: {}
            check_sources.check_source(src, ctx, args)
            self.assertFalse(ctx["state"]["sources"]["s"]["llm_pending"])
            check_sources.llm.extract = broken
            check_sources.check_source(src, ctx, args)  # без изменений и без долга — LLM не зовём
            self.assertEqual(len(calls), 2)
        finally:
            check_sources.fetch, check_sources.llm.extract = orig_fetch, orig_extract


if __name__ == "__main__":
    unittest.main()
