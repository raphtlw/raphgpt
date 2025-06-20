use actix_web::{
    HttpResponse, Responder, delete, get, post,
    web::{Data, Json, Path},
};
use redis::AsyncCommands;
use redis::aio::MultiplexedConnection;
use serde_json::{Value, json};

use crate::task::Task;

/// Enqueue: POST /tasks/{job_type}   body = arbitrary JSON params
#[post("/tasks/{job_type}")]
pub async fn enqueue(
    redis: Data<MultiplexedConnection>,
    path: Path<String>,
    body: Json<Value>,
) -> impl Responder {
    let job_type = path.into_inner();
    let task = Task::new(job_type, body.into_inner());
    let id = task.id;
    let key = format!("task:{}", id);

    let mut conn = redis.get_ref().clone();
    if let Err(err) = async {
        // store the full task under task:{id} with 10m TTL
        let payload = serde_json::to_string(&task)?;
        let _: () = conn.set_ex(&key, payload, 600).await?;
        // push just the id onto the pending list
        let _: () = conn.lpush("queue:pending", id.to_string()).await?;
        Ok::<_, anyhow::Error>(())
    }
    .await
    {
        log::error!("failed to enqueue task: {:?}", err);
        return HttpResponse::InternalServerError().finish();
    };

    HttpResponse::Accepted().json(json!({ "id": id }))
}

/// GET /tasks/{id} → either {"status":"processing"} or the raw results JSON
#[get("/tasks/{id}")]
pub async fn get_status(redis: Data<MultiplexedConnection>, path: Path<String>) -> impl Responder {
    let id = path.into_inner();
    let mut conn = redis.get_ref().clone();
    let result_key = format!("results:{}", id);
    match conn.get::<_, Option<String>>(result_key.clone()).await {
        Ok(Some(raw_json)) => HttpResponse::Ok()
            .content_type("application/json")
            .body(raw_json),
        Ok(None) => HttpResponse::Ok().json(json!({ "status": "processing" })),
        Err(e) => {
            log::error!("redis GET error: {:?}", e);
            HttpResponse::InternalServerError().finish()
        }
    }
}

/// GET /tasks → list all IDs + status
#[get("/tasks")]
pub async fn list_tasks(redis: Data<MultiplexedConnection>) -> impl Responder {
    let mut conn = redis.get_ref().clone();

    let pending: Vec<String> = conn
        .lrange("queue:pending", 0, -1)
        .await
        .unwrap_or_default();
    let processing: Vec<String> = conn
        .lrange("queue:processing", 0, -1)
        .await
        .unwrap_or_default();
    let results_keys: Vec<String> = conn.keys("results:*").await.unwrap_or_default();

    let mut statuses = std::collections::HashMap::new();
    for id in pending {
        statuses.insert(id, "pending");
    }
    for id in processing {
        statuses.insert(id, "processing");
    }
    for key in results_keys {
        if let Some(id) = key.strip_prefix("results:") {
            statuses.insert(id.to_string(), "completed");
        }
    }

    let list: Vec<_> = statuses
        .into_iter()
        .map(|(id, status)| json!({ "id": id, "status": status }))
        .collect();

    HttpResponse::Ok().json(list)
}

/// DELETE /tasks/{id}
#[delete("/tasks/{id}")]
pub async fn delete_task(redis: Data<MultiplexedConnection>, path: Path<String>) -> impl Responder {
    let id = path.into_inner();
    let mut conn = redis.get_ref().clone();

    let _: Result<(), _> = conn.lrem("queue:pending", 0, &id).await;
    let _: Result<(), _> = conn.lrem("queue:processing", 0, &id).await;
    let _: Result<(), _> = conn.del(format!("task:{}", id)).await;
    let _: Result<(), _> = conn.del(format!("results:{}", id)).await;

    HttpResponse::NoContent().finish()
}

/// DELETE /tasks
#[delete("/tasks")]
pub async fn delete_all(redis: Data<MultiplexedConnection>) -> impl Responder {
    let mut conn = redis.get_ref().clone();
    let _: Result<(), _> = conn.del(("queue:pending", "queue:processing")).await;

    if let Ok(keys) = conn.keys::<_, Vec<String>>("results:*").await {
        if !keys.is_empty() {
            let _: Result<(), _> = conn.del(keys).await;
        }
    }

    HttpResponse::NoContent().finish()
}
