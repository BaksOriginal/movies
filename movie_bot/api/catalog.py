"""
api/catalog.py — серверный шлюз между мини-аппом (index.html) и Supabase.

Зачем это нужно: любой ключ, который лежит в исходниках index.html,
виден всем — это и есть anon/publishable key. Раньше мини-апп ходил в
Supabase прямо из браузера этим ключом, поэтому таблицы titles и
bot_authorized_users приходилось делать публично читаемыми/писаемыми
(RLS-политика "allow anon all"), а значит и анонимному прохожему тоже.

Теперь мини-апп ходит только сюда. Здесь мы:
  1. Проверяем ПОДПИСЬ initData (не initDataUnsafe!) — доказываем, что
     запрос реально пришёл из Telegram WebApp именно от этого
     пользователя. initDataUnsafe в браузере можно подделать в
     devtools, initData с hash-подписью — нельзя: подпись считается
     секретным токеном бота, которого у клиента нет.
  2. Проверяем, что этот user_id есть в bot_authorized_users.
  3. Только после этого читаем/пишем в Supabase через SERVICE_ROLE_KEY —
     он обходит RLS и никогда не попадает в браузер.

Требуется новая переменная окружения на Vercel: SUPABASE_SERVICE_ROLE_KEY
(взять в Supabase Dashboard → Project Settings → API → service_role
secret). Это НЕ тот ключ, что в script.js/index.html — тот трогать не
нужно, а этот нигде, кроме серверных переменных окружения, светиться не
должен: он равнозначен полному доступу к базе в обход всех политик.
"""

import hashlib
import hmac
import json
import os
import time
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, parse_qsl, urlparse

import requests

BOT_TOKEN = os.environ["BOT_TOKEN"]
SUPABASE_URL = "https://nwkgofmgluduldgsmwfa.supabase.co"
SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

REST_HEADERS = {
    "apikey": SERVICE_ROLE_KEY,
    "Authorization": f"Bearer {SERVICE_ROLE_KEY}",
    "Content-Type": "application/json",
}

MAX_INIT_DATA_AGE = 24 * 60 * 60  # секунд; можно сделать строже


def verify_init_data(init_data: str) -> dict | None:
    """Проверяет подпись Telegram WebApp initData по алгоритму из их
    документации. Возвращает распарсенные поля (включая 'user') либо
    None, если подписи нет / она неверна / данные протухли."""
    if not init_data:
        return None

    pairs = dict(parse_qsl(init_data, strict_parsing=True))
    received_hash = pairs.pop("hash", None)
    if not received_hash:
        return None

    data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(pairs.items()))
    secret_key = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
    computed_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()

    if not hmac.compare_digest(computed_hash, received_hash):
        return None

    auth_date = int(pairs.get("auth_date", 0))
    if time.time() - auth_date > MAX_INIT_DATA_AGE:
        return None

    if "user" in pairs:
        pairs["user"] = json.loads(pairs["user"])
    return pairs


def is_authorized(user_id: int) -> bool:
    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/bot_authorized_users",
        headers=REST_HEADERS,
        params={"user_id": f"eq.{user_id}", "select": "user_id"},
        timeout=10,
    )
    resp.raise_for_status()
    return len(resp.json()) > 0


def get_catalog() -> list:
    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/titles",
        headers=REST_HEADERS,
        params={"select": "title,year,category,genre,franchise"},
        timeout=10,
    )
    resp.raise_for_status()
    return resp.json()


def insert_titles(rows: list) -> None:
    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/titles",
        headers=REST_HEADERS,
        json=rows,
        timeout=10,
    )
    resp.raise_for_status()


class handler(BaseHTTPRequestHandler):
    def _json(self, status: int, payload) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _authorized_user_id(self, init_data: str):
        data = verify_init_data(init_data)
        if not data or "user" not in data:
            return None
        user_id = data["user"]["id"]
        return user_id if is_authorized(user_id) else None

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        qs = parse_qs(urlparse(self.path).query)
        init_data = qs.get("initData", [""])[0]

        if not self._authorized_user_id(init_data):
            self._json(403, {"error": "unauthorized"})
            return

        try:
            self._json(200, get_catalog())
        except Exception as e:
            self._json(500, {"error": str(e)})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(body)
        except Exception:
            self._json(400, {"error": "bad json"})
            return

        if not self._authorized_user_id(payload.get("initData", "")):
            self._json(403, {"error": "unauthorized"})
            return

        rows = payload.get("rows")
        if not isinstance(rows, list) or not rows:
            self._json(400, {"error": "no rows"})
            return

        try:
            insert_titles(rows)
            self._json(200, {"ok": True})
        except Exception as e:
            self._json(500, {"error": str(e)})
