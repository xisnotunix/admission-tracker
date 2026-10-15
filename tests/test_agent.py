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
