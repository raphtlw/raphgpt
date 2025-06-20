use actix_web::{App, HttpServer, web::Data};
use color_eyre::Result;
use futures::FutureExt;
use redis::Client;
use std::collections::HashMap;
use std::sync::Arc;
use uuid::Uuid;

mod api;
mod task;
mod tasks;
mod worker;

#[actix_web::main]
async fn main() -> Result<()> {
    color_eyre::install()?;
    env_logger::init();

    // --- Redis setup
    let redis_url = std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1/".to_owned());
    let client = Client::open(redis_url)?;

    // establish a multiplexed Redis connection
    let manager = client.get_multiplexed_async_connection().await?;

    // --- Build the job registry
    let mut map: HashMap<String, worker::Handler> = HashMap::new();
    map.insert(
        "codex".into(),
        Arc::new(|id: Uuid, params: serde_json::Value| tasks::codex::run_job(id, params).boxed()),
    );
    // ← add more: e.g. "foo" → tasks::foo::run_job
    let handlers = Arc::new(map);

    // --- Spawn the worker loop
    {
        let h = handlers.clone();
        actix_web::rt::spawn(async move {
            if let Err(e) = worker::run(h).await {
                log::error!("worker crashed: {:?}", e);
            }
        });
    }

    // --- HTTP server
    HttpServer::new(move || {
        App::new()
            .app_data(Data::new(manager.clone()))
            .service(api::enqueue)
            .service(api::get_status)
            .service(api::list_tasks)
            .service(api::delete_task)
            .service(api::delete_all)
    })
    .bind(("0.0.0.0", 80))?
    .run()
    .await?;

    Ok(())
}
