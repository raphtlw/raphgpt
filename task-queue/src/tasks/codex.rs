use serde_json::{Value, json};
use uuid::Uuid;

use aws_config::{Region, meta::region::RegionProviderChain};
use aws_credential_types::Credentials;
use aws_sdk_s3::Client as S3;
use bytes::Bytes;
use color_eyre::{
    Result,
    eyre::{Context, eyre},
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io::{self, Cursor},
    path::Path,
};
use tempfile::TempDir;
use tokio::process::Command;
use walkdir::WalkDir;
use zip::{ZipArchive, write::SimpleFileOptions};

#[derive(Serialize, Deserialize)]
pub struct CodexResult {
    pub assistant_msg: String,
    pub generated_zip: String, // S3 key to generated zip file
}

/// Executes a Codex job in a fresh temporary working directory (auto-deleted on drop).
/// If `input_zip_key` is set, the zip is downloaded from S3 and extracted before running Codex.
pub async fn run(id: &Uuid, prompt: &str, input_zip_key: Option<String>) -> Result<CodexResult> {
    let tmp = TempDir::new().context("create tmpdir")?;
    let dir = tmp.path();

    if let Some(key) = input_zip_key {
        let bucket = std::env::var("S3_BUCKET")?;
        let cfg = aws_config::from_env()
            .region(RegionProviderChain::first_try(
                std::env::var("S3_REGION").ok().map(Region::new),
            ))
            .credentials_provider(Credentials::from_keys(
                std::env::var("S3_ACCESS_KEY_ID")?,
                std::env::var("S3_SECRET_ACCESS_KEY")?,
                None,
            ))
            .load()
            .await;
        let client = S3::new(&cfg);

        let resp = client.get_object().bucket(&bucket).key(&key).send().await?;
        let data = resp
            .body
            .collect()
            .await
            .context("reading input zip from S3")?;
        let bytes = data.into_bytes();

        let cursor = Cursor::new(bytes);
        let mut archive = ZipArchive::new(cursor).context("parsing input zip archive")?;
        archive
            .extract(dir)
            .context("extracting input zip archive")?;
    }

    let out = Command::new("codex")
        .arg("--full-auto")
        .arg("--quiet")
        .arg(prompt)
        .current_dir(dir)
        .output()
        .await
        .context("running codex")?;

    if !out.status.success() {
        return Err(eyre!(
            "Codex CLI failed (code {:?}):\n{}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr)
        ));
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    let assistant_msg = extract_assistant_message(&stdout).unwrap_or_else(|| "<no answer>".into());

    /* 2. If codex generated files → zip them */
    let maybe_zip = if fs::read_dir(dir)?.count() > 0 {
        let zip_path = dir.parent().unwrap().join(format!("codex_{}.zip", id));
        create_zip(&zip_path, dir)?;
        Some(Bytes::from(fs::read(&zip_path)?))
    } else {
        None
    };

    let s3_key = if let Some(bytes) = maybe_zip {
        let bucket = std::env::var("S3_BUCKET")?;
        let cfg = aws_config::from_env()
            .region(RegionProviderChain::first_try(
                std::env::var("S3_REGION").ok().map(Region::new),
            ))
            .credentials_provider(Credentials::from_keys(
                std::env::var("S3_ACCESS_KEY_ID")?,
                std::env::var("S3_SECRET_ACCESS_KEY")?,
                None,
            ))
            .load()
            .await;
        let client = S3::new(&cfg);
        let key = format!("codex/{}.zip", id);
        upload_zip(&client, &bucket, &key, bytes).await?;
        key
    } else {
        String::new()
    };

    Ok(CodexResult {
        assistant_msg,
        generated_zip: s3_key,
    })
}

fn extract_assistant_message(s: &str) -> Option<String> {
    s.lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find_map(|obj| {
            (obj.get("role")?.as_str()? == "assistant"
                && obj.get("type")?.as_str()? == "message"
                && obj.get("status")?.as_str()? == "completed")
                .then(|| {
                    obj.get("content")?
                        .as_array()?
                        .iter()
                        .find(|c| c.get("type").unwrap().as_str().unwrap() == "output_text")
                        .and_then(|c| c.get("text")?.as_str())
                        .map(|s| s.to_owned())
                })
                .flatten()
        })
}

fn create_zip(zip_path: &Path, root: &Path) -> Result<()> {
    let file = File::create(zip_path)?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for entry in WalkDir::new(root).into_iter().filter_map(Result::ok) {
        let path = entry.path();
        if path.is_file() {
            let mut f = File::open(path)?;
            let name = path.strip_prefix(root)?.to_string_lossy();
            zip.start_file(name, opts)?;
            io::copy(&mut f, &mut zip)?;
        }
    }
    zip.finish()?;
    Ok(())
}

/// Uploads the generated zip to S3 under the given key.
pub async fn upload_zip(
    client: &S3,
    bucket: &str,
    key: &str,
    bytes: Bytes,
) -> Result<()> {
    use aws_sdk_s3::primitives::ByteStream;
    client
        .put_object()
        .bucket(bucket)
        .key(key)
        .body(ByteStream::from(bytes))
        .send()
        .await
        .context("put_object")?;
    Ok(())
}

pub async fn run_job(id: Uuid, params: Value) -> Value {
    // parse your parameters
    let prompt = params
        .get("prompt")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let chat_id = params
        .get("chat_id")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let reply_to = params.get("reply_to_message_id").and_then(Value::as_i64);
    let input_zip_key = params
        .get("input_zip_key")
        .and_then(Value::as_str)
        .map(ToString::to_string);

    // call codex::run(...) which returns a `CodexResult`
    match run(&id, prompt, input_zip_key).await {
        Ok(res) => json!({
            "status": "completed",
            "data": res,
            "chat_id": chat_id,
            "reply_to_message_id": reply_to,
        }),
        Err(e) => {
            log::error!("codex task {} failed: {:?}", id, e);
            json!({
                "status": "error",
                "message": format!("{e:#}"),
                "chat_id": chat_id,
                "reply_to_message_id": reply_to,
            })
        }
    }
}
