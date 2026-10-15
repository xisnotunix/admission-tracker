"""Извлечение данных со страницы через бесплатный LLM API (Gemini или Groq).

Провайдер выбирается переменной LLM_PROVIDER (gemini | groq), по умолчанию —
тот, для которого задан ключ (GEMINI_API_KEY или GROQ_API_KEY).
"""
import json
import os
import re
import time

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


GEMINI_API = "https://generativelanguage.googleapis.com/v1beta"

# Бесплатные тарифы ограничивают запросы в минуту: держим паузу между вызовами
# и повторяем после ожидания при 429 (лимит) и 5xx (перегрузка).
MIN_INTERVAL = float(os.environ.get("LLM_MIN_INTERVAL", "7"))
_last_call = 0.0


def _post(url, **kwargs):
    global _last_call
    for attempt in range(5):
        wait = MIN_INTERVAL - (time.monotonic() - _last_call)
        if wait > 0:
            time.sleep(wait)
        _last_call = time.monotonic()
        r = requests.post(url, **kwargs)
        if r.status_code not in (429, 500, 502, 503, 504) or attempt == 4:
            return r
        retry_after = r.headers.get("Retry-After", "")
        delay = float(retry_after) if retry_after.isdigit() else 15 * (attempt + 1)
        print(f"[llm] HTTP {r.status_code}, повтор через {delay:.0f} с")
        time.sleep(delay)
    return r
_gemini_model = None  # модель, найденная автоматически, если GEMINI_MODEL сняли с поддержки


def pick_gemini_model(names):
    """Самая новая обычная Flash-модель из списка (без lite/image/tts/preview и т.п.)."""
    names = [n.split("/")[-1] for n in names]
    flash = [n for n in names if "flash" in n]
    stable = [n for n in flash if not re.search(r"lite|image|tts|live|audio|thinking|exp|preview", n)]
    pool = stable or flash
    if not pool:
        return None

    def key(n):
        m = re.search(r"gemini-(\d+(?:\.\d+)?)", n)
        return (float(m.group(1)) if m else 0.0, -len(n))

    return max(pool, key=key)


def _gemini_models(api_key):
    r = requests.get(f"{GEMINI_API}/models", params={"pageSize": 1000},
                     headers={"x-goog-api-key": api_key}, timeout=60)
    r.raise_for_status()
    return [m["name"] for m in r.json().get("models", [])
            if "generateContent" in m.get("supportedGenerationMethods", [])]


def _call_gemini(system_prompt, user_prompt):
    global _gemini_model
    api_key = os.environ["GEMINI_API_KEY"]
    body = {
        "systemInstruction": {"parts": [{"text": system_prompt}]},
        "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
        "generationConfig": {"temperature": 0, "responseMimeType": "application/json"},
    }
    for attempt in range(2):
        model = _gemini_model or GEMINI_MODEL
        r = _post(f"{GEMINI_API}/models/{model}:generateContent",
                          headers={"x-goog-api-key": api_key}, json=body, timeout=120)
        if r.status_code == 404 and attempt == 0:
            # Модели снимают с поддержки — берём актуальную Flash из списка доступных ключу.
            _gemini_model = pick_gemini_model(_gemini_models(api_key))
            print(f"[llm] модель {model} недоступна, использую {_gemini_model}")
            if _gemini_model and _gemini_model != model:
                continue
        r.raise_for_status()
        return r.json()["candidates"][0]["content"]["parts"][0]["text"]


def _call_groq(system_prompt, user_prompt):
    r = _post(
        "https://api.groq.com/openai/v1/chat/completions",
        headers={"Authorization": f"Bearer {os.environ['GROQ_API_KEY']}"},
        json={
            "model": GROQ_MODEL,
            "temperature": 0,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        },
        timeout=120,
    )
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]


DISCOVER_PROMPT = """Ты просматриваешь официальную страницу со списком конкурсов/стипендий на обучение за рубежом.
Найди программы, по которым можно получить БАКАЛАВРИАТ (или где уровень не указан) гражданину Кыргызстана.
Правила:
- Используй ТОЛЬКО текст страницы. Ничего не додумывай.
- Для каждой программы дай "quote" — ДОСЛОВНЫЙ фрагмент страницы (до 200 символов), где она упомянута.
- "url" — только из списка ССЫЛКИ НА СТРАНИЦЕ ниже, иначе null.
- "deadline_text" — срок подачи, как он написан на странице, или null.
- Если программ нет (например, «Актуальных конкурсов пока нет») — верни пустой список.
Ответь ТОЛЬКО JSON: {"programs": [{"name": "...", "country": null, "level": null, "url": null, "deadline_text": null, "quote": "..."}]}"""


def _run(system_prompt, user_prompt):
    p = provider()
    if p is None:
        print("[llm] ключ не задан (GEMINI_API_KEY / GROQ_API_KEY) — извлечение пропущено")
        return None
    raw = _call_gemini(system_prompt, user_prompt) if p == "gemini" else _call_groq(system_prompt, user_prompt)
    raw = raw.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?|```$", "", raw, flags=re.MULTILINE).strip()
    return json.loads(raw)


def extract(program, url, text):
    """Вернуть dict с извлечёнными полями или None, если LLM не настроен."""
    return _run(SYSTEM_PROMPT, _user_prompt(program, url, text))


def discover(url, text, links):
    """Найти программы на странице-каталоге. links — список (текст, url) со страницы."""
    link_lines = "\n".join(f"- {t} -> {u}" for t, u in links[:150])
    prompt = (
        f"URL страницы: {url}\n\nТЕКСТ СТРАНИЦЫ:\n<<<\n{relevant_excerpt(text, MAX_CHARS - 3000)}\n>>>\n\n"
        f"ССЫЛКИ НА СТРАНИЦЕ:\n{link_lines[:3000]}"
    )
    return _run(DISCOVER_PROMPT, prompt)
