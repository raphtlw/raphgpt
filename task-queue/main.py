from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from queue_core import RedisTaskQueue

app = FastAPI(title="Redis Task Queue API")

queue = RedisTaskQueue()


class TaskIn(BaseModel):
    func_path: str
    args: Optional[List[Any]] = []
    kwargs: Optional[Dict[str, Any]] = {}


class TaskOut(BaseModel):
    id: str
    func_path: str
    args: List[Any]
    kwargs: Dict[str, Any]
    status: str
    result: Optional[Any] = None
    error: Optional[Any] = None


@app.post("/tasks", response_model=Dict)
def create_task(task: TaskIn):
    task_id = queue.add_task(task.func_path, task.args, task.kwargs)
    return {"task_id": task_id}


@app.get("/tasks", response_model=List[TaskOut])
def list_tasks(status: Optional[str] = None):
    statuses = status.split(",") if status else None
    return queue.list_tasks(statuses)


@app.get("/tasks/{task_id}", response_model=TaskOut)
def get_task(task_id: str):
    task = queue.get_task_data(task_id)
    if not task:
        raise HTTPException(404, "Task not found")
    return task
