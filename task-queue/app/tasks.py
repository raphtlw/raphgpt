import asyncio
import os
import subprocess
import tempfile
import zipfile

from tg import bot


def build_and_send_codex_website(prompt, chat_id):
    """
    Builds a website using codex CLI, zips it, and sends it via Telegram.
    """

    if not chat_id:
        raise RuntimeError("Chat ID not provided")

    with tempfile.TemporaryDirectory() as tmpdir:
        site_dir = os.path.join(tmpdir, "site")
        os.makedirs(site_dir, exist_ok=True)
        # Run codex CLI
        result = subprocess.run(
            [
                "codex",
                "-a",
                "auto-edit",
                "--quiet",
                prompt,
            ],
            capture_output=True,
            text=True,
            env=os.environ,
        )
        if result.returncode != 0:
            raise RuntimeError(f"Codex CLI failed: {result.stderr}")

        print("=== Codex output ===\n", result.stdout, result.stderr)

        zip_path = os.path.join(tmpdir, "website.zip")
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for root, _, files in os.walk(site_dir):
                for file in files:
                    absfile = os.path.join(root, file)
                    arcname = os.path.relpath(absfile, site_dir)
                    zf.write(absfile, arcname)

        # Send via telegram-bot
        with open(zip_path, "rb") as f:
            msg = asyncio.run(
                bot.send_document(
                    chat_id=chat_id,
                    document=f,
                    filename="website.zip",
                    caption=f"Website built for: {prompt[:100]}",
                )
            )

    return {"status": "sent", "message_id": msg.message_id}


def add(a, b):
    """Return the sum of a and b."""
    return a + b


def greet(name):
    """Say hello."""
    return f"Hello, {name}!"


def fail():
    """Always fails."""
    raise Exception("This always fails.")
