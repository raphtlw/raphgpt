import asyncio
import logging
import os
import ssl
import subprocess
import tempfile
import zipfile
from pathlib import Path
from typing import Any

import boto3
from botocore.exceptions import NoCredentialsError
from celery import Celery
from telegram import Bot

from .utils import safe_filename

# Configuration from environment: S3 bucket, region, and credentials
S3_BUCKET = os.environ["S3_BUCKET"]
S3_REGION = os.environ["S3_REGION"]
S3_ACCESS_KEY_ID = os.environ["S3_ACCESS_KEY_ID"]
S3_SECRET_ACCESS_KEY = os.environ["S3_SECRET_ACCESS_KEY"]

# Configure Celery to use Redis as both broker and result backend
REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

celery_app = Celery(
    "task_runner",
    broker=REDIS_URL,
    backend=REDIS_URL,
    broker_use_ssl={"ssl_cert_reqs": ssl.CERT_NONE},
    redis_backend_use_ssl={"ssl_cert_reqs": ssl.CERT_NONE},
)

# Use JSON serialization
celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    result_expires=int(os.environ.get("RESULT_TTL_SECONDS", 600)),
)

# Initialize S3 client
s3 = boto3.client(
    "s3",
    region_name=S3_REGION,
    aws_access_key_id=S3_ACCESS_KEY_ID,
    aws_secret_access_key=S3_SECRET_ACCESS_KEY,
)

# Logger for task diagnostics
logger = logging.getLogger(__name__)

# Telegram Bot for sending messages/files
TELEGRAM_BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
bot = Bot(token=TELEGRAM_BOT_TOKEN)


async def _download_songs_from_spotify_logic(
    chat_id: int,
    queries: list[str],
    reply_to_message_id: int | None = None,
    client_id: str | None = None,
    client_secret: str | None = None,
) -> dict[str, str]:
    """
    Downloads and sends audio tracks specified from Spotify using spotdl:
    1. Download tracks via spotdl
    2. Package into a ZIP, upload to S3
    3. Send the ZIP file to the specified Telegram chat
    """
    client_id = client_id or os.environ.get("SPOTIFY_CLIENT_ID")
    client_secret = client_secret or os.environ.get("SPOTIFY_CLIENT_SECRET")
    if not client_id or not client_secret:
        raise RuntimeError(
            "Spotify client_id and client_secret must be provided via payload or SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET env vars"
        )

    # Use spotdl CLI to download tracks to a temporary directory
    with tempfile.TemporaryDirectory() as download_dir:
        cmd = [
            "spotdl",
            "download",
            *queries,
            "--client-id",
            client_id,
            "--client-secret",
            client_secret,
        ]
        logger.debug("Running spotdl CLI command: %s", " ".join(cmd))
        result = await asyncio.to_thread(
            subprocess.run,
            cmd,
            cwd=download_dir,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            logger.error("spotdl CLI failed: %s", result.stderr)
            raise RuntimeError(f"spotdl CLI failed: {result.stderr}")

        downloaded_files = list(Path(download_dir).glob("*"))

        tmp_zip = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
        zip_path = Path(tmp_zip.name)
        tmp_zip.close()
        with zipfile.ZipFile(zip_path, "w") as zf:
            for file_path in downloaded_files:
                zf.write(file_path, arcname=safe_filename(file_path.name))

    await asyncio.to_thread(
        bot.send_document,
        chat_id,
        document=open(zip_path, "rb"),
        reply_to_message_id=reply_to_message_id,
    )


@celery_app.task(name="download_songs_from_spotify")
def download_songs_from_spotify(
    chat_id: int,
    queries: list[str],
    reply_to_message_id: int | None = None,
    client_id: str | None = None,
    client_secret: str | None = None,
) -> dict[str, str]:
    """
    Wrapper for running Spotify download logic in Celery.
    """
    return asyncio.run(
        _download_songs_from_spotify_logic(
            chat_id, queries, reply_to_message_id, client_id, client_secret
        )
    )
