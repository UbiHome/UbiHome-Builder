//! Config validation. Reuses UbiHome's real validator by building a `ubihome`
//! binary from the requested tag and running `ubihome -c <config> validate`.
//! The result is the identical `serde_saphyr` + `garde` reporting the device
//! sees.
//!
//! Shares [`crate::compile::prepare_and_compile`] with [`crate::compile::build`]:
//! the binary is trimmed to only the platform components the config actually
//! references, and validating uses the exact same worktree/target dir a build
//! of the same version+components would, so whichever runs first compiles and
//! the other reuses it. Only the final step differs — build ships the binary,
//! validate runs it with `validate` and reports what it prints.

use std::path::PathBuf;
use std::process::Stdio;

use tokio::sync::mpsc::UnboundedSender;

use crate::git::Repo;
use crate::platforms::detect_platforms;
use crate::BuilderError;

/// Outcome of validating a config.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ValidationResult {
    pub ok: bool,
    /// Combined stdout+stderr from `ubihome validate` (the diagnostic report).
    pub output: String,
    /// Resolved version the config was validated against.
    pub version: String,
}

/// Validate a config against a specific version (`None` = latest stable).
/// Compiles a host validator binary for the config's component set (reusing
/// a build's worktree/target dir if one already compiled it), then runs it
/// against a temp copy of the config. Progress and the validator's own
/// stdout/stderr are streamed line-by-line to `log` as they happen.
pub async fn validate(
    repo: &Repo,
    reference: Option<&str>,
    config: &str,
    log: UnboundedSender<String>,
) -> Result<ValidationResult, BuilderError> {
    let selected = detect_platforms(config);
    let (bin, _is_windows, resolved) =
        crate::compile::prepare_and_compile(repo, reference, &selected, &None, false, &log)
            .await?;

    let mut tmp: PathBuf = std::env::temp_dir();
    tmp.push(format!(
        "ubihome-builder-validate-{}-{}.yml",
        std::process::id(),
        config.len()
    ));
    tokio::fs::write(&tmp, config)
        .await
        .map_err(|e| BuilderError::Validate(format!("cannot write temp config: {e}")))?;

    // Note: `-c/--configuration` is a global flag and must precede `validate`.
    let _ = log.send("$ ubihome validate".to_string());
    let child = tokio::process::Command::new(&bin)
        .arg("-c")
        .arg(&tmp)
        .arg("validate")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| BuilderError::Validate(format!("could not run validator: {e}")))?;
    let (status, lines) = crate::compile::run_streaming(child, &log).await?;

    let _ = tokio::fs::remove_file(&tmp).await;

    Ok(ValidationResult {
        ok: status.success(),
        output: lines.join("\n").trim().to_string(),
        version: resolved,
    })
}
