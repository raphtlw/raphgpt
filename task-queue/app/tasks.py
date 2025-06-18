import asyncio
import json
import os
import tempfile
import zipfile

import telegramify_markdown
from telegram import ReplyParameters
from tg import bot


def extract_last_assistant_message(stdout: str) -> str | None:
    result = None
    for line in stdout.splitlines():
        try:
            obj = json.loads(line)
            if (
                obj.get("role") == "assistant"
                and obj.get("type") == "message"
                and obj.get("status") == "completed"
                and isinstance(obj.get("content"), list)
            ):
                for c in obj["content"]:
                    if c.get("type") == "output_text" and "text" in c:
                        result = c["text"]
        except Exception:
            continue
    return result


async def async_subprocess_run(cmd, *args, **kwargs):
    """Runs subprocess and returns (returncode, stdout, stderr) asynchronously."""
    process = await asyncio.create_subprocess_exec(
        cmd,
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        **kwargs,
    )
    stdout, stderr = await process.communicate()
    return process.returncode, stdout.decode(), stderr.decode()


async def run_codex(prompt, chat_id, reply_to_message_id):
    if not chat_id:
        raise RuntimeError("Chat ID not provided")

    with tempfile.TemporaryDirectory() as tmpdir:
        # Run codex CLI asynchronously
        returncode, stdout, stderr = await async_subprocess_run(
            "codex",
            "--full-auto",
            "--quiet",
            f'"{prompt}"',
            cwd=tmpdir,  # To ensure it writes into the correct folder if needed
        )
        if returncode != 0:
            # Forward stderr to the user if you like
            await bot.send_message(
                chat_id=chat_id, text=f"Codex CLI failed:\n{stderr[:4096]}"
            )
            raise RuntimeError(f"Codex CLI failed: {stderr}")

        print("=== Codex output ===\n", stdout, stderr)

        assistant_message: str | None = None
        for line in stdout.splitlines():
            try:
                obj = json.loads(line)
                if (
                    obj.get("role") == "assistant"
                    and obj.get("type") == "message"
                    and obj.get("status") == "completed"
                    and isinstance(obj.get("content"), list)
                ):
                    for c in obj["content"]:
                        if c["type"] == "output_text" and "text" in c:
                            assistant_message = c["text"]
            except Exception:
                continue

        # check if there is folder content
        # if not, then end run
        if len(os.listdir(tmpdir)) > 0:
            # zip site_dir (the generated website)
            zip_path = os.path.join(tmpdir, "website.zip")
            with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
                for root, _, files in os.walk(tmpdir):
                    for file in files:
                        absfile = os.path.join(root, file)
                        arcname = os.path.relpath(absfile, tmpdir)
                        zf.write(absfile, arcname)

            # Send via telegram-bot
            with open(zip_path, "rb") as f:
                await bot.send_document(
                    chat_id=chat_id,
                    document=f,
                    filename="website.zip",
                    caption=f"Website built for: {prompt[:100]}",
                )

        await bot.send_message(
            chat_id,
            telegramify_markdown.markdownify(assistant_message),
            parse_mode="MarkdownV2",
            reply_parameters=ReplyParameters(reply_to_message_id),
        )

    return {"assistant_message": assistant_message}


# Remaining tasks can easily be made async (optional for simple stateless ones)
async def add(a, b):
    """Return the sum of a and b."""
    return a + b


async def greet(name):
    """Say hello."""
    return f"Hello, {name}!"


async def fail():
    """Always fails."""
    raise Exception("This always fails.")
