use aws_config::{Region, meta::region::RegionProviderChain};
use aws_credential_types::Credentials;
use aws_sdk_s3::{Client as S3, presigning::PresigningConfig};
use bytes::Bytes;
use color_eyre::{
    Result,
    eyre::{Context, eyre},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs::{self, File},
    io,
    path::Path,
    time::Duration,
};
use tempfile::TempDir;
use tokio::process::Command;
use uuid::Uuid;
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;

#[derive(Serialize, Deserialize)]
pub struct CodexResult {
    pub assistant_msg: String,
    pub generated_zip: String, // S3 key to generated zip file
}

pub async fn run(id: &Uuid, prompt: &str) -> Result<CodexResult> {
    let tmp = TempDir::new().context("create tmpdir")?;
    let dir = tmp.path();

    /* 1. Spawn the codex CLI */
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
        let zip_path = dir.parent().unwrap().join(format!("codex_{}.zip", &id));
        create_zip(&zip_path, dir)?;
        Some(Bytes::from(fs::read(&zip_path)?))
    } else {
        None
    };

    let (s3_key, _presigned) = if let Some(bytes) = maybe_zip {
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
        let key = format!("codex/{}.zip", &id);
        let url = upload_zip_and_presign(&client, &bucket, &key, bytes).await?;
        (key, url)
    } else {
        (String::new(), String::new())
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

pub async fn upload_zip_and_presign(
    client: &S3,
    bucket: &str,
    key: &str,
    bytes: Bytes,
) -> Result<String> {
    use aws_sdk_s3::primitives::ByteStream;
    client
        .put_object()
        .bucket(bucket)
        .key(key)
        .body(ByteStream::from(bytes))
        .send()
        .await
        .context("put_object")?;
    let presigned = client
        .get_object()
        .bucket(bucket)
        .key(key)
        .presigned(PresigningConfig::expires_in(Duration::from_secs(3600))?)
        .await?;
    Ok(presigned.uri().to_string())
}
