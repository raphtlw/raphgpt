use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

#[derive(Serialize, Deserialize, Debug)]
pub struct Task {
    pub id: Uuid,
    pub enqueued_at: i64,
    pub job_type: String,
    pub params: Value,
}

impl Task {
    /// Create a new task of `job_type` with arbitrary JSON `params`.
    pub fn new(job_type: impl Into<String>, params: Value) -> Self {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time went backwards")
            .as_secs() as i64;
        Task {
            id: Uuid::new_v4(),
            enqueued_at: now,
            job_type: job_type.into(),
            params,
        }
    }
}
