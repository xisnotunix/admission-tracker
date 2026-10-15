"""Извлечение данных со страницы через бесплатный LLM API (Gemini или Groq).

Провайдер выбирается переменной LLM_PROVIDER (gemini | groq), по умолчанию —
тот, для которого задан ключ (GEMINI_API_KEY или GROQ_API_KEY).
"""
import json
import os
import re

import requests

GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
GROQ_MODEL = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile")

# Groq на бесплатном тарифе ограничен по токенам в минуту, поэтому
# отправляем не всю страницу, а релевантные фрагменты (не больше MAX_CHARS).
MAX_CHARS = int(os.environ.get("LLM_MAX_CHARS", "12000"))

KEYWORDS = re.compile(
    r"deadline|due|apply|application|call|open|close|until|submit|"
    r"requirement|eligib|language|english|japanese|ielts|toefl|exam|test|"
    r"transcript|document|certificate|grade|gpa|score|minimum|bachelor|undergraduate|"
    r"january|february|march|april|may|june|july|august|september|october|november|december|"
    r"\d{4}|"
    r"срок|дедлайн|приём|прием|подач|документ|экзамен|требован|оценк|балл|ОРТ|"
    r"январ|феврал|март|апрел|мая|май|июн|июл|август|сентябр|октябр|ноябр|декабр",
    re.IGNORECASE,
)

SYSTEM_PROMPT = """Ты извлекаешь факты о приёме на бакалавриат с официальной веб-страницы.
Правила:
- Используй ТОЛЬКО текст страницы ниже. Ничего не додумывай и не используй свои знания.
- Если факта на странице нет — ставь null. Лучше null, чем догадка.
- Для каждого найденного факта дай "quote": ДОСЛОВНЫЙ фрагмент текста страницы (до 200 символов),
  скопированный символ в символ, который подтверждает факт. Без цитаты факт не принимается.
- Даты — в формате YYYY-MM-DD, время — HH:MM (24 ч), часовой пояс — как написано на странице
  (например "CET") или null.
- Если на странице несколько дедлайнов, выбери относящийся к бакалавриату (Bachelor/undergraduate)
  и к указанному учебному году; если неясно — null.
- value для требований — коротко, по-русски.
Ответь ТОЛЬКО JSON такого вида:
{
  "deadline": {"date": null, "time": null, "timezone": null, "quote": null},
  "opens": {"date": null, "quote": null},
  "requirements": {
    "language": {"value": null, "quote": null},
    "exams": {"value": null, "quote": null},
    "documents": {"value": null, "quote": null},
    "min_grades": {"value": null, "quote": null}
  }
}"""


def relevant_excerpt(text, max_chars=MAX_CHARS):
    """Строки с ключевыми словами + по одной соседней строке."""
    if len(text) <= max_chars:
        return text
    lines = text.split("\n")
    keep = set()
    for i, line in enumerate(lines):
        if KEYWORDS.search(line):
            keep.update({i - 1, i, i + 1})
    out, size = [], 0
    for i in sorted(k for k in keep if 0 <= k < len(lines)):
        if size + len(lines[i]) + 1 > max_chars:
            break
        out.append(lines[i])
        size += len(lines[i]) + 1
    return "\n".join(out)


def provider():
    p = os.environ.get("LLM_PROVIDER", "").lower()
    if p:
        return p
    if os.environ.get("GEMINI_API_KEY"):
        return "gemini"
    if os.environ.get("GROQ_API_KEY"):
        return "groq"
    return None


def _user_prompt(program, url, text):
    return (
        f"Программа: {program['name']} ({program['country']}).\n"
        f"Абитуриент: школьник из Кыргызстана, бакалавриат.\n"
        f"URL страницы: {url}\n\n"
        f"ТЕКСТ СТРАНИЦЫ:\n<<<\n{relevant_excerpt(text)}\n>>>"
    )


def _call_gemini(user_prompt):
    r = requests.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent",
        headers={"x-goog-api-key": os.environ["GEMINI_API_KEY"], "Content-Type": "application/json"},
        json={
            "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
            "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
            "generationConfig": {"temperature": 0, "responseMimeType": "application/json"},
        },
        timeout=120,
    )
    r.raise_for_status()
    return r.json()["candidates"][0]["content"]["parts"][0]["text"]


def _call_groq(user_prompt):
    r = requests.post(
        "https://api.groq.com/openai/v1/chat/completions",
        headers={"Authorization": f"Bearer {os.environ['GROQ_API_KEY']}"},
        json={
            "model": GROQ_MODEL,
            "temperature": 0,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
        },
        timeout=120,
    )
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]


def extract(program, url, text):
    """Вернуть dict с извлечёнными полями или None, если LLM не настроен."""
    p = provider()
    if p is None:
        print("[llm] ключ не задан (GEMINI_API_KEY / GROQ_API_KEY) — извлечение пропущено")
        return None
    prompt = _user_prompt(program, url, text)
    raw = _call_gemini(prompt) if p == "gemini" else _call_groq(prompt)
    raw = raw.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?|```$", "", raw, flags=re.MULTILINE).strip()
    return json.loads(raw)
