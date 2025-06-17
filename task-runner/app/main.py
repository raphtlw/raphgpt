from typing import Any

from celery.result import AsyncResult
from fastapi import FastAPI
from pydantic import BaseModel

from .tasks import celery_app, download_songs_from_spotify

api = FastAPI(title="Task Runner")


class DownloadSpotifyRequest(BaseModel):
    chat_id: int
    queries: list[str]
    reply_to_message_id: int | None = None
    client_id: str | None = None
    client_secret: str | None = None


class JobStatus(BaseModel):
    task_id: str
    status: str
    result: Any | None = None
    traceback: str | None = None


@api.post("/tasks/download-songs-from-spotify")
async def trigger_download_songs(request: DownloadSpotifyRequest):
    result = download_songs_from_spotify.delay(
        chat_id=request.chat_id,
        queries=request.queries,
        reply_to_message_id=request.reply_to_message_id,
        client_id=request.client_id,
        client_secret=request.client_secret,
    )
    return {
        "task_id": result.id,
        "task_type": "download_songs_from_spotify",
        "status": "submitted",
    }


@api.get("/tasks/{task_id}/status", response_model=JobStatus)
async def get_task_status(task_id: str):
    result = AsyncResult(task_id, app=celery_app)
    return {
        "task_id": task_id,
        "status": result.status,
        "result": result.result if result.ready() else None,
        "traceback": result.traceback if result.failed() else None,
    }


@api.get("/tasks", response_model=dict)
async def list_active_tasks():
    inspect = celery_app.control.inspect()
    active_tasks = inspect.active() or {}
    return {"active_tasks": active_tasks}


@api.delete("/tasks/{task_id}", response_model=dict)
async def cancel_task(task_id: str):
    celery_app.control.revoke(task_id, terminate=True)
    return {"message": f"Task {task_id} cancelled"}
