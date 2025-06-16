import asyncio
import csv
import logging
import os
import tempfile
import zipfile
from typing import Any, Callable
from uuid import uuid4

import boto3
from botocore.exceptions import NoCredentialsError
from telegram import Bot
from yt_dlp import YoutubeDL

from .utils import safe_filename

# Configuration from environment: S3 bucket, region, and credentials; optional cookies key
S3_BUCKET = os.environ["S3_BUCKET"]
S3_REGION = os.environ["S3_REGION"]
S3_ACCESS_KEY_ID = os.environ["S3_ACCESS_KEY_ID"]
S3_SECRET_ACCESS_KEY = os.environ["S3_SECRET_ACCESS_KEY"]
COOKIES_S3_KEY = os.environ.get("YTDLP_COOKIES_S3_KEY", "yt-dlp/raphtlw_cookies.txt")

# Initialize S3 client using explicit S3_* environment variables
s3 = boto3.client(
    "s3",
    region_name=S3_REGION,
    aws_access_key_id=S3_ACCESS_KEY_ID,
    aws_secret_access_key=S3_SECRET_ACCESS_KEY,
)

# logger for task diagnostics
logger = logging.getLogger(__name__)

# Telegram Bot for sending messages/files
TELEGRAM_BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
bot = Bot(token=TELEGRAM_BOT_TOKEN)

# Registry of available tasks
tasks: dict[str, Callable[..., Any]] = {}


def task(name: str):
    """
    Decorator to register a function as a named background task.
    """

    def decorator(fn):
        tasks[name] = fn
        return fn

    return decorator


@task("download_songs_from_csv")
async def download_songs_from_csv(
    chat_id: int,
    csv_s3_key: str,
    start: int | None = None,
    end: int | None = None,
    reply_to_message_id: int | None = None,
) -> None:
    """
    Downloads tracks listed in a CSV (S3), zips MP3s, uploads ZIP to S3,
    and sends the ZIP file to the given Telegram chat via python-telegram-bot.

    Parameters:
    - chat_id: Telegram chat ID to send the ZIP to
    - csv_s3_key: S3 key of the CSV file in S3 bucket
    - start: 1-based first row index (inclusive, optional)
    - end: 1-based last row index (inclusive, optional)
    - reply_to_message_id: message to reply to in Telegram (optional)
    """
    logger.info(
        "Starting download_songs_from_csv: chat_id=%s csv_s3_key=%s start=%s end=%s",
        chat_id,
        csv_s3_key,
        start,
        end,
    )
    if not csv_s3_key:
        logger.error("No csv_s3_key provided")
        raise ValueError("csv_s3_key must be provided")

    # Fetch CSV from S3
    logger.debug("Fetching CSV from S3: bucket=%s key=%s", S3_BUCKET, csv_s3_key)
    try:
        obj = await asyncio.to_thread(s3.get_object, Bucket=S3_BUCKET, Key=csv_s3_key)
    except NoCredentialsError:
        logger.error("AWS credentials not found for fetching CSV")
        raise RuntimeError(
            "AWS credentials missing: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY"
        )
    csv_text = (await asyncio.to_thread(obj["Body"].read)).decode("utf-8")
    rows = list(csv.DictReader(csv_text.splitlines()))
    total = len(rows)
    logger.info("Parsed CSV: %d rows found", total)

    # Compute slicing indices (0-based)
    start_idx = (start - 1) if start is not None else 0
    end_idx = (end - 1) if end is not None else total - 1
    start_idx = max(start_idx, 0)
    end_idx = min(end_idx, total - 1)
    if start_idx > end_idx:
        raise ValueError(f"Invalid range [{start or 1}, {end or total}]")
    rows = rows[start_idx : end_idx + 1]

    if not rows:
        raise ValueError("No rows to process")

    temp_dir = tempfile.mkdtemp()
    downloaded: list[str] = []
    failed: list[str] = []

    # Fetch cookies file from S3
    cook_obj = await asyncio.to_thread(
        s3.get_object, Bucket=S3_BUCKET, Key=COOKIES_S3_KEY
    )
    cookies_text = (await asyncio.to_thread(cook_obj["Body"].read)).decode("utf-8")
    cookies_path = os.path.join(temp_dir, "cookies.txt")
    with open(cookies_path, "w", encoding="utf-8") as fp:
        fp.write(cookies_text)

    # Process each track: search, download, convert
    for idx, row in enumerate(rows, start=start_idx + 1):
        title = (row.get("Track Name") or row.get("track name") or "").strip()
        artist = (row.get("Artist Name(s)") or row.get("artist name(s)") or "").strip()
        if not title:
            logger.warning("Row %d has no title; skipping", idx)
            failed.append("<unknown title>")
            continue
        query = f"{title} {artist}".strip()
        logger.debug("Searching for row %d query=%s", idx, query)
        try:
            info = await asyncio.to_thread(
                lambda: YoutubeDL({"quiet": True}).extract_info(
                    f"ytsearch1:{query}", download=False
                )
            )
            entry = info.get("entries", [None])[0]
            url = entry.get("webpage_url") if entry else None
            if not url:
                raise RuntimeError("no URL found in search result")
        except Exception as e:
            logger.warning("Search failed for %s: %s", query, e)
            failed.append(query)
            continue

        # Core downloading into the temporary directory
        safe_name = safe_filename(f"{title} - {artist}")
        outtmpl = os.path.join(temp_dir, f"{safe_name}.%(ext)s")
        ydl_opts = {
            "format": "bestaudio/best",
            "postprocessors": [
                {
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "aac",
                    "preferredquality": 0,
                },
                {"key": "FFmpegMetadata"},
                {"key": "EmbedThumbnail"},
            ],
            "writethumbnail": True,
            "cookiefile": cookies_path,
            "outtmpl": outtmpl,
        }
        try:
            logger.debug("Downloading for %s into %s", query, outtmpl)
            await asyncio.to_thread(lambda: YoutubeDL(ydl_opts).download([url]))
            # detect downloaded file by extension
            for ext in ("aac", "m4a", "mp3"):
                file_path = os.path.join(temp_dir, f"{safe_name}.{ext}")
                if os.path.exists(file_path):
                    downloaded.append(file_path)
                    break
            else:
                raise FileNotFoundError(safe_name)
            logger.info("Successfully downloaded %s", downloaded[-1])
        except Exception as e:
            logger.warning("Download failed for %s: %s", query, e)
            failed.append(query)

    if not downloaded:
        logger.error("No tracks were downloaded; failing task")
        raise RuntimeError("No tracks could be downloaded")

    # Create ZIP archive
    zip_name = f"songs_{uuid4().hex}.zip"
    zip_path = os.path.join(temp_dir, zip_name)
    logger.debug("Creating ZIP archive at %s", zip_path)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for mp3 in downloaded:
            zf.write(mp3, arcname=os.path.basename(mp3))
    logger.info("ZIP archive created: %s", zip_path)

    # Upload ZIP to S3
    zip_s3_key = f"downloads/{zip_name}"
    logger.debug("Uploading ZIP to S3: bucket=%s key=%s", S3_BUCKET, zip_s3_key)
    try:
        with open(zip_path, "rb") as fp:
            await asyncio.to_thread(s3.upload_fileobj, fp, S3_BUCKET, zip_s3_key)
    except NoCredentialsError:
        logger.error("AWS credentials not found for uploading ZIP")
        raise RuntimeError(
            "AWS credentials missing: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY"
        )
    logger.info("Uploaded ZIP to S3: %s", zip_s3_key)

    # Send ZIP to Telegram
    caption = f"✅ Downloaded {len(downloaded)} tracks."
    if failed:
        caption += f" Skipped {len(failed)}: {', '.join(failed)}"
    logger.info("Sending ZIP to chat_id=%s reply_to=%s", chat_id, reply_to_message_id)
    with open(zip_path, "rb") as zf:
        await bot.send_document(
            chat_id=chat_id,
            document=zf,
            caption=caption,
            reply_to_message_id=reply_to_message_id,
        )
