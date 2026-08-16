"""
Телеграм-бот в виде serverless-функции (Vercel).

В отличие от "классического" бота с polling (он должен работать
непрерывно, постоянно спрашивая Telegram "есть новое сообщение?"),
здесь используется webhook: Telegram САМ присылает HTTP-запрос сюда
только тогда, когда пользователь что-то написал. Всё остальное время
эта функция просто не существует ("холодный старт" перед следующим
сообщением занимает доли секунды и незаметен) — идеально ложится на
бесплатный serverless-тариф, где платят/считают лимит только за
реальные вызовы, а не за время простоя.

Логика функционала не изменилась:
1. Первое сообщение — бот просит пароль ("maxii1360" или "asmodayrules").
2. После верного пароля Telegram ID сохраняется в Supabase
   (bot_authorized_users) — второй раз пароль не спросится.
3. Авторизованному пользователю бот присылает кнопку, открывающую
   мини-приложение (форма добавления фильмов, стилизованная под сайт).

ИЗМЕНЕНИЕ БЕЗОПАСНОСТИ: bot_authorized_users теперь закрыта RLS-политикой
от анонимного доступа (см. rls_migration.sql) — раньше anon-ключ мог
читать/писать эту таблицу напрямую, а значит кто угодно мог вставить
туда свой user_id в обход пароля. Поэтому здесь используется
SUPABASE_SERVICE_ROLE_KEY (обходит RLS) вместо анонимного ключа.
Это секретный ключ уровня "root" для базы — держите его только в
переменных окружения Vercel, никогда не коммитьте и не отправляйте
в браузер.
"""

import json
import os
from http.server import BaseHTTPRequestHandler

import requests

BOT_TOKEN = os.environ["BOT_TOKEN"]
WEBAPP_URL = os.environ["WEBAPP_URL"]  # https-ссылка на webapp/index.html (см. README)

SUPABASE_URL = "https://nwkgofmgluduldgsmwfa.supabase.co"
SUPABASE_SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
VALID_PASSWORDS = {"maxii1360", "asmodayrules"}

TELEGRAM_API = f"https://api.telegram.org/bot{BOT_TOKEN}"
REST_HEADERS = {
    "apikey": SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
    "Content-Type": "application/json",
}


def tg_send_message(chat_id: int, text: str, reply_markup: dict | None = None) -> None:
    payload = {"chat_id": chat_id, "text": text}
    if reply_markup:
        payload["reply_markup"] = reply_markup
    requests.post(f"{TELEGRAM_API}/sendMessage", json=payload, timeout=10)


def webapp_keyboard() -> dict:
    return {"inline_keyboard": [[{"text": "🎬 Добавить фильмы", "web_app": {"url": WEBAPP_URL}}]]}


def is_authorized(user_id: int) -> bool:
    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/bot_authorized_users",
        headers=REST_HEADERS,
        params={"user_id": f"eq.{user_id}", "select": "user_id"},
        timeout=10,
    )
    resp.raise_for_status()
    return len(resp.json()) > 0


def save_authorized(user_id: int, username: str | None) -> None:
    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/bot_authorized_users",
        headers={**REST_HEADERS, "Prefer": "resolution=merge-duplicates"},
        json={"user_id": user_id, "username": username},
        timeout=10,
    )
    resp.raise_for_status()


def send_menu(chat_id: int) -> None:
    tg_send_message(
        chat_id,
        "Доступ подтверждён ✅\n\nЖми кнопку ниже, чтобы открыть форму добавления фильмов "
        "(до 10 строк за раз, как на сайте).",
        webapp_keyboard(),
    )


def process_update(update: dict) -> None:
    message = update.get("message")
    if not message or "text" not in message:
        return

    chat_id = message["chat"]["id"]
    user = message["from"]
    user_id = user["id"]
    text = message["text"].strip()

    if text in ("/start", "/add"):
        if is_authorized(user_id):
            send_menu(chat_id)
        elif text == "/add":
            tg_send_message(chat_id, "Сначала введи пароль. Набери /start.")
        else:
            tg_send_message(chat_id, "Привет! 🔒 Это приватный бот для добавления фильмов.\nВведи пароль:")
        return

    if is_authorized(user_id):
        send_menu(chat_id)
        return

    if text in VALID_PASSWORDS:
        save_authorized(user_id, user.get("username"))
        tg_send_message(chat_id, "Пароль верный! Доступ открыт навсегда. ✅")
        send_menu(chat_id)
    else:
        tg_send_message(chat_id, "Неверный пароль. Попробуй ещё раз:")


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else b"{}"
        try:
            update = json.loads(body or b"{}")
            process_update(update)
        except Exception as e:  # не роняем функцию — Telegram будет ретраить 5xx бесконечно
            print("webhook error:", e)

        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(b"ok")

    def do_GET(self):
        # Просто чтобы можно было открыть ссылку в браузере и убедиться,
        # что функция задеплоена и отвечает.
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(b"movie-bot webhook is alive")
