import json
import os
import uuid

import redis

REDIS_URL = os.environ.get("REDIS_URL")
QUEUE = "task_queue"
TASK_KEY_PREFIX = "task:"

redis_client = redis.Redis.from_url(REDIS_URL, decode_responses=True)


def get_task_key(task_id):
    return f"{TASK_KEY_PREFIX}{task_id}"


class RedisTaskQueue:
    def __init__(self):
        self.redis = redis_client

    def add_task(self, func_path, args=None, kwargs=None):
        task_id = str(uuid.uuid4())
        tkey = get_task_key(task_id)
        task_data = {
            "id": task_id,
            "func_path": func_path,
            "args": json.dumps(args or []),
            "kwargs": json.dumps(kwargs or {}),
            "status": "queued",
            "result": "",
            "error": "",
        }
        # Store details and push id to queue
        self.redis.hmset(tkey, task_data)
        self.redis.lpush(QUEUE, task_id)
        return task_id

    def get_task_ids(self):
        # Returns a list of ids (queued order)
        return self.redis.lrange(QUEUE, 0, -1)

    def get_task_data(self, task_id):
        data = self.redis.hgetall(get_task_key(task_id))
        if data:
            # Parse args/kwargs/result if needed
            if data.get("args"):
                data["args"] = json.loads(data["args"])
            if data.get("kwargs"):
                data["kwargs"] = json.loads(data["kwargs"])
            # Try result/error parsing
            for key in ["result", "error"]:
                try:
                    data[key] = json.loads(data[key])
                except Exception:
                    pass
            return data
        return None

    def list_tasks(self, statuses=None):
        keys = self.redis.keys(f"{TASK_KEY_PREFIX}*")
        tasks = []
        for k in keys:
            if k == QUEUE:
                continue
            # k is like "task:<id>"
            task_id = k[len(TASK_KEY_PREFIX) :]
            data = self.get_task_data(task_id)
            if data:
                tasks.append(data)
        if statuses:
            tasks = [t for t in tasks if t["status"] in statuses]
        return tasks

    def pop_next_task(self):
        # Atomically pop next task id
        task_id = self.redis.rpop(QUEUE)
        if not task_id:
            return None, None
        tkey = get_task_key(task_id)
        task = self.redis.hgetall(tkey)
        return task_id, task

    def update_task_status(self, task_id, status, result=None, error=None):
        update = {"status": status}
        if result is not None:
            update["result"] = json.dumps(result)
        if error is not None:
            update["error"] = json.dumps(str(error))
        tkey = get_task_key(task_id)
        self.redis.hmset(tkey, update)
        # Set TTL for completed (done/failed) tasks
        if status in ("done", "failed"):
            self.redis.expire(tkey, 600)  # 600 seconds = 10 minutes
