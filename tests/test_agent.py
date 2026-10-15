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


if __name__ == "__main__":
    unittest.main()
