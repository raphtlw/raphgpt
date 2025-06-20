use crate::task::Task;
use futures::future::BoxFuture;
use redis::AsyncCommands;
use redis::Client;
use redis::Direction;
use serde_json::Value;
use std::{collections::HashMap, sync::Arc};
use uuid::Uuid;

pub type Handler = Arc<dyn Fn(Uuid, Value) -> BoxFuture<'static, Value> + Send + Sync>;

/// This loop never returns.  It:
/// 1) Re-queues any in‐flight `processing` items back to `pending` on startup  
/// 2) Blocks on BLMOVE(pending→processing)  
/// 3) GETs task:{id}, runs the appropriate handler, SETs results:{id}, LREM processing  
pub async fn run(handlers: Arc<HashMap<String, Handler>>) -> anyhow::Result<()> {
    let redis_url = std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1/".to_owned());
    let client = Client::open(redis_url)?;

    // establish a multiplexed Redis connection
    let redis = client.get_multiplexed_async_connection().await?;

    // 1) requeue
    {
        let mut conn = redis.clone();
        let inflight: Vec<String> = conn.lrange("queue:processing", 0, -1).await?;
        for id in inflight {
            let _: () = conn.rpush("queue:pending", &id).await?;
        }
        let _: () = conn.del("queue:processing").await?;
    }

    loop {
        let mut conn = redis.clone();
        // 2) atomically move one ID
        let id_str: String = conn
            .blmove(
                "queue:pending",
                "queue:processing",
                Direction::Right,
                Direction::Left,
                0.0,
            )
            .await?;
        let id = Uuid::parse_str(&id_str)?;

        // 3) LOAD & DESERIALIZE
        let raw: String = conn.get(format!("task:{}", id_str)).await?;
        let task: Task = serde_json::from_str(&raw)?;

        log::debug!("Task: {:#?}", task);

        // DISPATCH
        let handler = handlers
            .get(&task.job_type)
            .ok_or_else(|| anyhow::anyhow!("Unknown job_type {}", task.job_type))?;
        let result_value: Value = handler(id, task.params).await;
        let result_json = serde_json::to_string(&result_value)?;

        // STORE result + ACK
        let _: () = conn.set(format!("results:{}", id_str), result_json).await?;
        let _: () = conn.lrem("queue:processing", 1, &id_str).await?;
    }
}
