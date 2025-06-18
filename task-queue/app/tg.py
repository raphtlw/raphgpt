import os

from telegram import Bot

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
TELEGRAM_API_URL = os.getenv("TELEGRAM_API_URL")

bot = Bot(token=TELEGRAM_BOT_TOKEN, base_url=f"{TELEGRAM_API_URL}/bot")
