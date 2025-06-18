import importlib
import json
import time

from core import RedisTaskQueue


def run_worker(poll_interval=1.0):
    queue = RedisTaskQueue()
    print("Worker started.")
    while True:
        task_id, task = queue.pop_next_task()
        if not task_id:
            # No tasks, sleep and retry
            time.sleep(poll_interval)
            continue

        print(
            f"Running task {task_id}: {task['func_path']} ({task['args']}, {task['kwargs']})"
        )
        queue.update_task_status(task_id, "running")  # Mark as running

        try:
            module_name, func_name = task["func_path"].rsplit(".", 1)
            mod = importlib.import_module(module_name)
            func = getattr(mod, func_name)
            args = json.loads(task.get("args", "[]"))
            kwargs = json.loads(task.get("kwargs", "{}"))
            result = func(*args, **kwargs)
            queue.update_task_status(task_id, "done", result=result)
            print(f"Task {task_id} done: {result!r}")
        except Exception as exc:
            queue.update_task_status(task_id, "failed", error=str(exc))
            print(f"Task {task_id} failed: {exc!r}")


if __name__ == "__main__":
    run_worker()
