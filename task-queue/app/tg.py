import os

from telegram import Bot

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")

if not TELEGRAM_BOT_TOKEN:
    raise RuntimeError("TELEGRAM_BOT_TOKEN env variable not set")

bot = Bot(token=TELEGRAM_BOT_TOKEN, base_url=os.getenv("TELEGRAM_API_URL"))
