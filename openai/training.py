import glob
import json

import pandas as pd
import tiktoken

# Read all Telegram JSON files with names like tg-*.json
raw_data = []
for file_path in glob.glob("tg-*.json"):
    with open(file_path, "r", encoding="utf-8") as f:
        raw_data.extend(json.load(f)["messages"][:])

df = pd.DataFrame(raw_data)
print("Preview of raw data:")
print(df.head())

# Get the desired token encoding instance.
encoding = tiktoken.get_encoding("cl100k_base")

# Define the system instruction.
system_message = {
    "role": "system",
    "content": "Raphael is a direct, no-nonsense conversationalist who mixes humor, spontaneity, and pragmatism.",
}

# We will build conversation turns where each turn consists of:
#   1. A (possibly merged) user message.
#   2. The subsequent (merged) assistant message.
conversation_turns = []
pending_user = None  # holds accumulated user messages
pending_assistant = None  # holds accumulated assistant messages

MIN_TOKENS = 2
MAX_TOKENS = 1000

# Iterate through each message in order.
for _, row in df.iterrows():
    # Ensure that the message has text.
    if not isinstance(row.get("text"), str):
        continue
    text = row["text"].strip()
    if text == "":
        continue
    # Filter out messages that contain "sql" or the end-of-text marker.
    if (
        "sql" in text.lower()
        or "<|endoftext|>" in text.lower()
        or "<|im_start|>" in text.lower()
        or "<|im_end|>" in text.lower()
    ):
        continue

    # Determine the speaker.
    role = "assistant" if row.get("from") == "Raphael" else "user"

    # Process user messages.
    if role == "user":
        # If a complete turn exists (pending both user and assistant), check assistant token count.
        if pending_user is not None and pending_assistant is not None:
            # Check if assistant reply meets quality threshold:
            tokenized_assistant = encoding.encode(pending_assistant)
            if (
                len(tokenized_assistant) >= MIN_TOKENS
                and len(tokenized_assistant) <= MAX_TOKENS
            ):
                conversation_turns.append(
                    {
                        "messages": [
                            # system_message,
                            {"role": "user", "content": pending_user},
                            {"role": "assistant", "content": pending_assistant},
                        ]
                    }
                )
            pending_user, pending_assistant = None, None
        # Merge consecutive user messages.
        if pending_user is None:
            pending_user = text
        else:
            pending_user += " " + text

    # Process assistant messages.
    elif role == "assistant":
        # Only process an assistant reply if we already have a preceding user message.
        if pending_user is None:
            continue
        if pending_assistant is None:
            pending_assistant = text
        else:
            pending_assistant += f"<|NEWMSG|>{text}"

        # If the current assistant message has reached or exceeded the minimum token count,
        # then "commit" this conversation turn.
        tokenized_assistant = encoding.encode(pending_assistant)
        if (
            len(tokenized_assistant) >= MIN_TOKENS
            and len(tokenized_assistant) <= MAX_TOKENS
        ):
            conversation_turns.append(
                {
                    "messages": [
                        # system_message,
                        {"role": "user", "content": pending_user},
                        {"role": "assistant", "content": pending_assistant},
                    ]
                }
            )
            pending_user, pending_assistant = None, None

# If at the end we have a complete pending turn, check token threshold before appending.
if pending_user is not None and pending_assistant is not None:
    tokenized_assistant = encoding.encode(pending_assistant)
    if (
        len(tokenized_assistant) >= MIN_TOKENS
        and len(tokenized_assistant) <= MAX_TOKENS
    ):
        conversation_turns.append(
            {
                "messages": [
                    # system_message,
                    {"role": "user", "content": pending_user},
                    {"role": "assistant", "content": pending_assistant},
                ]
            }
        )

# Save each conversation turn as a JSON object per line.
output_file = "formatted_conversations.jsonl"
with open(output_file, "w", encoding="utf-8") as f:
    for convo in conversation_turns:
        f.write(json.dumps(convo, ensure_ascii=False) + "\n")

print(f"Formatted conversations saved to {output_file}")
