use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

#[derive(Serialize, Deserialize, Debug)]
pub struct Task {
    pub id: Uuid,
    pub enqueued_at: i64,
    #[serde(flatten)]
    pub kind: TaskKind,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "job_type")]
pub enum TaskKind {
    #[serde(rename = "codex-run")]
    Codex { prompt: String },
    #[serde(other)]
    Other,
}

impl Task {
    pub fn codex(prompt: String) -> Self {
        Self {
            id: Uuid::new_v4(),
            enqueued_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs() as i64,
            kind: TaskKind::Codex { prompt },
        }
    }
}
