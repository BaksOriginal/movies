"""
Телеграм-бот для добавления фильмов в базу (без дублей).

Логика:
1. При первом обращении пользователя бот просит пароль.
   Подходит любой из двух: "maxii1360" или "asmodayrules".
2. После верного пароля Telegram ID пользователя навсегда сохраняется
   в таблице Supabase "bot_authorized_users" — второй раз пароль
   спрашиваться не будет (даже после перезапуска бота, т.к. это не
   локальный файл, а запись в облачной БД).
3. Авторизованному пользователю бот показывает кнопку, открывающую
   мини-приложение (Telegram WebApp) — форму добавления фильмов,
   стилизованную под сайт. Сама вставка в БД и проверка на дубли
   происходят прямо в мини-приложении (webapp/index.html), точно так
   же, как на сайте работает "Добавить тайтлы".
"""

import logging
import os

import requests
from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update, WebAppInfo
from telegram.ext import Application, CommandHandler, ContextTypes, MessageHandler, filters

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("movie-bot")

# ==========================================
# НАСТРОЙКИ (берутся из переменных окружения — см. README.md)
# ==========================================
BOT_TOKEN = os.environ["BOT_TOKEN"]
WEBAPP_URL = os.environ["WEBAPP_URL"]  # https-ссылка на захостенный webapp/index.html

# Те же данные, что уже "зашиты" в script.js сайта — используем тот же
# публичный anon key, тем же способом обращаемся к Supabase REST напрямую.
SUPABASE_URL = "https://nwkgofmgluduldgsmwfa.supabase.co"
SUPABASE_ANON_KEY = "sb_publishable_Igpb__d5aHp3DBbQH1NgOA_W8_Ku6aE"

VALID_PASSWORDS = {"maxii1360", "asmodayrules"}

REST_HEADERS = {
    "apikey": SUPABASE_ANON_KEY,
    "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
    "Content-Type": "application/json",
}


def is_authorized(user_id: int) -> bool:
    """Проверяем в Supabase, проходил ли этот Telegram ID проверку пароля."""
    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/bot_authorized_users",
        headers=REST_HEADERS,
        params={"user_id": f"eq.{user_id}", "select": "user_id"},
        timeout=10,
    )
    resp.raise_for_status()
    return len(resp.json()) > 0


def save_authorized(user_id: int, username: str | None) -> None:
    """Запоминаем, что пользователь ввёл верный пароль — навсегда."""
    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/bot_authorized_users",
        headers={**REST_HEADERS, "Prefer": "resolution=merge-duplicates"},
        json={"user_id": user_id, "username": username},
        timeout=10,
    )
    resp.raise_for_status()


def webapp_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [[InlineKeyboardButton("🎬 Добавить фильмы", web_app=WebAppInfo(url=WEBAPP_URL))]]
    )


async def send_menu(update: Update) -> None:
    await update.effective_message.reply_text(
        "Доступ подтверждён ✅\n\nЖми кнопку ниже, чтобы открыть форму добавления фильмов "
        "(до 10 строк за раз, как на сайте).",
        reply_markup=webapp_keyboard(),
    )


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user = update.effective_user
    if is_authorized(user.id):
        await send_menu(update)
    else:
        await update.effective_message.reply_text(
            "Привет! 🔒 Это приватный бот для добавления фильмов.\n"
            "Введи пароль, чтобы получить доступ:"
        )


async def add_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Быстрый доступ к форме без /start, если пользователь уже авторизован."""
    user = update.effective_user
    if is_authorized(user.id):
        await send_menu(update)
    else:
        await update.effective_message.reply_text("Сначала введи пароль. Набери /start.")


async def handle_text(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user = update.effective_user
    text = (update.effective_message.text or "").strip()

    if is_authorized(user.id):
        # Уже авторизован — просто напоминаем про кнопку, никакой логики
        # добавления фильма в текстовом чате нет, всё в мини-приложении.
        await send_menu(update)
        return

    if text in VALID_PASSWORDS:
        save_authorized(user.id, user.username)
        await update.effective_message.reply_text("Пароль верный! Доступ открыт навсегда. ✅")
        await send_menu(update)
    else:
        await update.effective_message.reply_text("Неверный пароль. Попробуй ещё раз:")


def main() -> None:
    app = Application.builder().token(BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("add", add_command))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text))
    log.info("Бот запущен, жду сообщений…")
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
