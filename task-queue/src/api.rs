use std::collections::HashMap;

use crate::{task::Task, tasks::codex::CodexResult};
use actix_web::{HttpResponse, Responder, delete, get, post, web};
use color_eyre::Result;
use redis;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Deserialize, Serialize)]
#[serde(untagged)]
pub enum TaskResult {
    Codex(CodexResult),
}

#[derive(Deserialize)]
pub struct CodexRequest {
    prompt: String,
}

#[post("/tasks/codex")]
pub async fn tasks_codex(
    redis_client: web::Data<redis::Client>,
    body: web::Json<CodexRequest>,
) -> impl Responder {
    match enqueue_job(&redis_client, Task::codex(body.prompt.clone())).await {
        Ok(id) => HttpResponse::Accepted().json(serde_json::json!({ "id": id })),
        Err(e) => {
            log::error!("enqueue error: {e:?}");
            HttpResponse::InternalServerError().finish()
        }
    }
}

/// GET /tasks/{id}
/// Get a task's result and status
#[get("/tasks/{id}")]
pub async fn task_status(
    redis_client: web::Data<redis::Client>,
    p: web::Path<(String,)>,
) -> impl Responder {
    let key = format!("results:{}", p.into_inner().0);
    let mut conn = match redis_client.get_multiplexed_async_connection().await {
        Ok(c) => c,
        Err(_) => return HttpResponse::InternalServerError().finish(),
    };
    match redis::cmd("GET")
        .arg(&key)
        .query_async::<Option<String>>(&mut conn)
        .await
    {
        Ok(Some(raw_json)) => {
            // we trust that raw_json is already {"status":"completed",…} or {"status":"error",…}
            HttpResponse::Ok()
                .content_type("application/json")
                .body(raw_json)
        }
        Ok(None) => HttpResponse::Ok().json(serde_json::json!({ "status": "processing" })),
        Err(e) => {
            log::error!("redis GET error: {:?}", e);
            HttpResponse::InternalServerError().finish()
        }
    }
}

async fn enqueue_job(redis_client: &redis::Client, task: Task) -> Result<Uuid> {
    let mut conn = redis_client.get_multiplexed_async_connection().await?;
    redis::cmd("LPUSH")
        .arg("queue:pending")
        .arg(serde_json::to_string(&task)?)
        .query_async::<()>(&mut conn)
        .await?;
    Ok(task.id)
}

#[derive(Serialize)]
struct TaskInfo {
    id: Uuid,
    status: String,
}

/// GET /tasks
/// List all tasks (pending, processing, completed)
#[get("/tasks")]
pub async fn list_tasks(redis_client: web::Data<redis::Client>) -> impl Responder {
    let mut conn = match redis_client.get_multiplexed_async_connection().await {
        Ok(c) => c,
        Err(e) => {
            log::error!("Redis conn error: {:?}", e);
            return HttpResponse::InternalServerError().finish();
        }
    };

    // 1) Pending
    let pending: Vec<String> = match redis::cmd("LRANGE")
        .arg("queue:pending")
        .arg(0)
        .arg(-1)
        .query_async(&mut conn)
        .await
    {
        Ok(v) => v,
        Err(e) => {
            log::error!("Error fetching pending: {:?}", e);
            return HttpResponse::InternalServerError().finish();
        }
    };

    // 2) Processing
    let processing: Vec<String> = match redis::cmd("LRANGE")
        .arg("queue:processing")
        .arg(0)
        .arg(-1)
        .query_async(&mut conn)
        .await
    {
        Ok(v) => v,
        Err(e) => {
            log::error!("Error fetching processing: {:?}", e);
            return HttpResponse::InternalServerError().finish();
        }
    };

    // 3) Completed → scan keys "results:*"
    let results_keys: Vec<String> = match redis::cmd("KEYS")
        .arg("results:*")
        .query_async(&mut conn)
        .await
    {
        Ok(v) => v,
        Err(e) => {
            log::error!("Error listing result keys: {:?}", e);
            return HttpResponse::InternalServerError().finish();
        }
    };

    // Build a map id → status (last wins: completed > processing > pending)
    let mut map: HashMap<Uuid, String> = HashMap::new();
    for raw in pending {
        if let Ok(task) = serde_json::from_str::<Task>(&raw) {
            map.insert(task.id, "pending".into());
        }
    }
    for raw in processing {
        if let Ok(task) = serde_json::from_str::<Task>(&raw) {
            map.insert(task.id, "processing".into());
        }
    }
    if !results_keys.is_empty() {
        // fetch all values in one go
        let raws: Vec<Option<String>> = redis::cmd("MGET")
            .arg(&results_keys)
            .query_async(&mut conn)
            .await
            .unwrap();
        for (key, maybe_json) in results_keys.into_iter().zip(raws.into_iter()) {
            if let Some(id_str) = key.strip_prefix("results:") {
                if let Ok(id) = Uuid::parse_str(id_str) {
                    let status = maybe_json
                        .and_then(|j| serde_json::from_str::<serde_json::Value>(&j).ok())
                        .and_then(|v| {
                            v.get("status")
                                .and_then(|s| s.as_str())
                                .map(|s| s.to_string())
                        })
                        .unwrap_or_else(|| "completed".into());
                    map.insert(id, status);
                }
            }
        }
    }

    let list: Vec<TaskInfo> = map
        .into_iter()
        .map(|(id, status)| TaskInfo { id, status })
        .collect();

    HttpResponse::Ok().json(list)
}

/// DELETE /tasks/{id}
/// Remove a single task from pending/processing, and delete its result
#[delete("/tasks/{id}")]
pub async fn delete_task(
    redis_client: web::Data<redis::Client>,
    p: web::Path<(String,)>,
) -> impl Responder {
    let id_str = p.into_inner().0;
    let id = match Uuid::parse_str(&id_str) {
        Ok(u) => u,
        Err(_) => return HttpResponse::BadRequest().body("Invalid UUID"),
    };

    let mut conn = match redis_client.get_multiplexed_async_connection().await {
        Ok(c) => c,
        Err(e) => {
            log::error!("Redis conn error: {:?}", e);
            return HttpResponse::InternalServerError().finish();
        }
    };

    // Helper: pull LRANGE, parse, LREM if id matches
    async fn scrub_list(conn: &mut redis::aio::MultiplexedConnection, list: &str, id: Uuid) {
        if let Ok(raws) = redis::cmd("LRANGE")
            .arg(list)
            .arg(0)
            .arg(-1)
            .query_async::<Vec<String>>(conn)
            .await
        {
            for raw in raws {
                if let Ok(task) = serde_json::from_str::<Task>(&raw) {
                    if task.id == id {
                        let _ = redis::cmd("LREM")
                            .arg(list)
                            .arg(1)
                            .arg(&raw)
                            .query_async::<()>(&mut *conn)
                            .await;
                    }
                }
            }
        }
    }

    scrub_list(&mut conn, "queue:pending", id).await;
    scrub_list(&mut conn, "queue:processing", id).await;
    let _ = redis::cmd("DEL")
        .arg(format!("results:{}", id))
        .query_async::<()>(&mut conn)
        .await;

    HttpResponse::NoContent().finish()
}

/// DELETE /tasks
/// Wipe all tasks (pending, processing, all results)
#[delete("/tasks")]
pub async fn delete_all_tasks(redis_client: web::Data<redis::Client>) -> impl Responder {
    let mut conn = match redis_client.get_multiplexed_async_connection().await {
        Ok(c) => c,
        Err(e) => {
            log::error!("Redis conn error: {:?}", e);
            return HttpResponse::InternalServerError().finish();
        }
    };

    // delete both queues in one fell swoop
    let _ = redis::cmd("DEL")
        .arg("queue:pending")
        .arg("queue:processing")
        .query_async::<()>(&mut conn)
        .await;

    // delete all results:*
    if let Ok(keys) = redis::cmd("KEYS")
        .arg("results:*")
        .query_async::<Vec<String>>(&mut conn)
        .await
    {
        if !keys.is_empty() {
            let mut cmd = redis::cmd("DEL");
            for k in keys {
                cmd.arg(k);
            }
            let _ = cmd.query_async::<()>(&mut conn).await;
        }
    }

    HttpResponse::NoContent().finish()
}
