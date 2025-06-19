mod api;
mod task;
mod tasks;
mod worker;

use actix_web::{App, HttpServer};
use color_eyre::eyre::{self, Result};

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<(), eyre::Report> {
    color_eyre::install()?;
    env_logger::init();

    // Redis client
    let redis_url = std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1/".to_owned());
    let redis_client = redis::Client::open(redis_url)?;

    // Task running worker
    worker::run(redis_client.clone()).await;

    // HTTP API
    HttpServer::new(move || {
        App::new()
            .app_data(actix_web::web::Data::new(redis_client.clone()))
            .service(api::task_status)
            .service(api::list_tasks)
            .service(api::delete_task)
            .service(api::delete_all_tasks)
            .service(api::tasks_codex)
    })
    .bind(("0.0.0.0", 80))?
    .run()
    .await?;

    Ok(())
}
