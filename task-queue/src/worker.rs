use crate::task::{Task, TaskKind};
use crate::tasks::codex::run as run_codex;
use color_eyre::Result;
use serde_json::json;

pub async fn run(redis_client: redis::Client) {
    // On startup, move any “in‐flight” tasks back to pending so they get retried
    if let Err(e) = requeue_processing(&redis_client).await {
        log::error!("failed to re-queue processing tasks: {:?}", e);
    }

    tokio::spawn(async move {
        loop {
            if let Err(e) = consume_once(&redis_client).await {
                log::error!("worker loop error: {e:?}");
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
        }
    });
}

async fn consume_once(redis_client: &redis::Client) -> Result<()> {
    let mut conn = redis_client.get_multiplexed_async_connection().await?;

    // atomically pop from pending → processing (block until something shows up)
    let raw: String = redis::cmd("BLMOVE")
        .arg("queue:pending")
        .arg("queue:processing")
        .arg("RIGHT")
        .arg("LEFT")
        .arg(0)
        .query_async(&mut conn)
        .await?;

    let task: Task = serde_json::from_str(&raw)?;

    // run it, but catch all errors
    let result_blob = match task.kind {
        TaskKind::Codex {
            prompt,
            chat_id,
            reply_to_message_id,
        } => match run_codex(&task.id, &prompt).await {
            Ok(res) => json!({
                "status": "completed",
                "data": res,
                "chat_id": chat_id,
                "reply_to_message_id": reply_to_message_id,
            }),
            Err(e) => {
                log::error!("task {} failed: {:?}", task.id, e);
                json!({
                    "status": "error",
                    "message": format!("{e:#}"),
                    "chat_id": chat_id,
                    "reply_to_message_id": reply_to_message_id,
                })
            }
        },
        TaskKind::Other => {
            log::warn!("unhandled task {:?}", task);
            json!({
                "status": "error",
                "message": "unhandled task kind"
            })
        }
    };

    let serialized = serde_json::to_string(&result_blob)?;
    redis::cmd("SET")
        .arg(format!("results:{}", task.id))
        .arg(&serialized)
        .query_async::<()>(&mut conn)
        .await?;

    // ACK: remove from processing
    redis::cmd("LREM")
        .arg("queue:processing")
        .arg(1)
        .arg(&raw)
        .query_async::<()>(&mut conn)
        .await?;

    Ok(())
}

/// Move everything from `queue:processing` back into `queue:pending` so we retry them
/// on startup after a crash or restart.
async fn requeue_processing(redis_client: &redis::Client) -> color_eyre::Result<()> {
    let mut conn = redis_client.get_multiplexed_async_connection().await?;

    let raws: Vec<String> = redis::cmd("LRANGE")
        .arg("queue:processing")
        .arg(0)
        .arg(-1)
        .query_async(&mut conn)
        .await?;

    if raws.is_empty() {
        return Ok(());
    }

    log::info!("Re-queueing {} tasks back to pending", raws.len());

    for raw in &raws {
        redis::cmd("RPUSH")
            .arg("queue:pending")
            .arg(raw)
            .query_async::<()>(&mut conn)
            .await?;
    }

    redis::cmd("DEL")
        .arg("queue:processing")
        .query_async::<()>(&mut conn)
        .await?;

    Ok(())
}
