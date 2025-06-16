import asyncio
import json
import os
import threading
from contextlib import asynccontextmanager
from inspect import signature
from typing import cast

import redis
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from .tasks import tasks

results: dict[str, dict] = {}

# Redis-backed queue config
REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
TASK_QUEUE_NAME = os.environ.get("TASK_QUEUE_NAME", "task_queue")
redis_client = redis.Redis.from_url(REDIS_URL)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # start background worker thread once at application startup
    threading.Thread(target=worker, daemon=True).start()
    yield


app = FastAPI(title="Task Runner", lifespan=lifespan)


class EnqueueRequest(BaseModel):
    payload: dict = {}


class JobStatus(BaseModel):
    status: str
    result: dict | list | str | None = None
    error: str | None = None


@app.post("/tasks/{task_name}")
async def enqueue(task_name: str, request: EnqueueRequest):
    if task_name not in tasks:
        raise HTTPException(status_code=404, detail=f"Unknown task: {task_name}")
    # validate that payload includes all required parameters for the task function
    fn = tasks[task_name]
    try:
        signature(fn).bind(**request.payload)
    except TypeError as err:
        raise HTTPException(
            status_code=422,
            detail=f"Invalid payload for task '{task_name}': {err}",
        )
    job_id = os.urandom(16).hex()
    job = {"id": job_id, "task": task_name, "payload": request.payload}
    await asyncio.to_thread(redis_client.rpush, TASK_QUEUE_NAME, json.dumps(job))
    return {"job_id": job_id}


@app.get("/tasks/{job_id}", response_model=JobStatus)
def get_result(job_id: str):
    entry = results.get(job_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return JobStatus(
        status=entry.get("status"),
        result=entry.get("result"),
        error=entry.get("error"),
    )


def worker():
    """
    Continuously retrieve jobs from Redis-backed queue and run registered tasks.
    """
    while True:
        # BLPOP blocks until an item is available
        _, payload = redis_client.blpop(TASK_QUEUE_NAME)
        job = json.loads(payload)
        task_name = cast(str, job.get("task"))
        fn = tasks.get(task_name)
        if fn is None:
            results[job["id"]] = {
                "status": "error",
                "error": f"Unknown task: {task_name}",
            }
            continue
        try:
            # execute coroutine in a fresh event loop
            output = asyncio.run(fn(**job.get("payload", {})))
            results[job["id"]] = {"status": "success", "result": output}
        except Exception as e:
            results[job["id"]] = {"status": "error", "error": str(e)}
