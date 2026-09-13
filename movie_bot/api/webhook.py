import json
import os
from http.server import BaseHTTPRequestHandler

import requests

BOT_TOKEN = os.environ["BOT_TOKEN"]
WEBAPP_URL = os.environ["WEBAPP_URL"]  # https-ссылка на webapp/index.html (см. README)

SUPABASE_URL = "https://nwkgofmgluduldgsmwfa.supabase.co"
SUPABASE_SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

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


def send_menu(chat_id: int) -> None:
    tg_send_message(
        chat_id,
        "Жми на кнопочку ниже",
        webapp_keyboard(),
    )


def process_update(update: dict) -> None:
    message = update.get("message")
    if not message or "text" not in message:
        return

    chat_id = message["chat"]["id"]
    user = message["from"]
    user_id = user["id"]
    if is_authorized(user_id):
        send_menu(chat_id)


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
