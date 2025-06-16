# Task Runner

This service provides an in-memory Python `queue.Queue` task queue and an HTTP API (FastAPI)
to enqueue background jobs and retrieve their results.

## API Endpoints

### Enqueue a job

```
POST /tasks/{task_name}
Content-Type: application/json

{
  "payload": { /* task-specific parameters */ }
}

Returns HTTP 422 if required parameters are missing or invalid for the specified task.
```

Response:

```json
{ "job_id": "<unique-job-id>" }
```

### Get job status/result

```
GET /tasks/{job_id}
```

Response (success):

```json
{ "status": "success", "result": /* task output */ }
```

Response (error):

```json
{ "status": "error", "error": "<error message>" }
```

## Built-in Tasks

### download_songs_from_csv

Downloads and sends audio tracks listed in a CSV stored in S3. The service will:
1. Fetch the CSV from S3 (requires AWS credentials via environment variables)
2. Search YouTube, download MP3s via yt-dlp
3. Package all MP3s into a ZIP, upload it to S3
4. Send the ZIP file directly to the specified Telegram chat

**Parameters (payload)**:

- `chat_id` (integer): Telegram chat ID to send the ZIP file to
- `reply_to_message_id` (integer, optional): Message ID to reply to in Telegram
- `csv_s3_key` (string): S3 key of the input CSV file
- `start` (integer, optional): 1-based first row index (inclusive)
- `end` (integer, optional): 1-based last row index (inclusive)

## Running Locally

Dependencies are managed via UV:

```bash
# Ensure Redis is running and configure the connection URL
export REDIS_URL=redis://localhost:6379/0
# (Optional) override the Redis queue name
export TASK_QUEUE_NAME=task_queue
# S3 access/configuration (via env vars):
export S3_ACCESS_KEY_ID=<your-access-key>
export S3_SECRET_ACCESS_KEY=<your-secret-key>
export S3_BUCKET=<your-bucket-name>
export S3_REGION=<your-aws-region>
# (Optional) path to yt-dlp cookies in S3 (defaults to "yt-dlp/raphtlw_cookies.txt")
export YTDLP_COOKIES_S3_KEY=<your-cookies-s3-key>

cd task-runner
uv sync
uv run main.py --port 80 --host 0.0.0.0
```

In Docker, the included Dockerfile will build and expose the service on port 80.