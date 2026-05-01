use std::fs;
use std::process::{Command, Stdio};
use std::time::SystemTime;

use anyhow::{bail, Context};
use camino::{Utf8Path, Utf8PathBuf};
use cargo_metadata::MetadataCommand;
use serde_json::Value;
use stackwise_core::{BuildInfo, ExactMode};

use crate::cli::Cli;
use crate::config::StackwiseConfig;
use crate::{analyze_and_write, exact_mode_from_arg};

#[derive(Debug)]
pub struct CargoAnalysisRequest {
    pub profile: String,
    pub target: Option<String>,
    pub features: Vec<String>,
    pub all_features: bool,
    pub no_default_features: bool,
    pub package: Option<String>,
    pub bin: Option<String>,
    pub example: Option<String>,
    pub workspace: bool,
    pub json: Option<Utf8PathBuf>,
    pub no_build: bool,
    pub exact_mode: ExactMode,
}

impl CargoAnalysisRequest {
    pub fn from_cli(cli: &Cli, config: StackwiseConfig) -> anyhow::Result<Self> {
        let configured_profile = config.build.and_then(|build| build.profile);
        let profile = cli
            .profile
            .clone()
            .or(configured_profile)
            .unwrap_or_else(|| {
                if cli.release {
                    "release".to_owned()
                } else {
                    "dev".to_owned()
                }
            });

        Ok(Self {
            profile,
            target: cli.target.clone(),
            features: cli.features.clone(),
            all_features: cli.all_features,
            no_default_features: cli.no_default_features,
            package: cli.package.clone(),
            bin: cli.bin.clone(),
            example: cli.example.clone(),
            workspace: cli.workspace,
            json: cli.json.clone(),
            no_build: cli.no_build,
            exact_mode: exact_mode_from_arg(cli.exact),
        })
    }
}

pub fn run_cargo_analysis(request: CargoAnalysisRequest) -> anyhow::Result<Utf8PathBuf> {
    let metadata = MetadataCommand::new()
        .exec()
        .context("failed to read cargo metadata")?;
    let workspace_root = Utf8PathBuf::from(metadata.workspace_root.as_str());
    let target_dir = Utf8PathBuf::from(metadata.target_directory.as_str());

    let artifact = if request.no_build {
        newest_artifact(&target_dir, &request)?
            .with_context(|| "no matching artifact found; run without --no-build first")?
    } else {
        build_and_capture_artifact(&request)?
    };

    let package_name = request.package.clone().or_else(|| {
        metadata
            .root_package()
            .map(|package| package.name.to_string())
    });
    let json_path = request.json.clone().unwrap_or_else(|| {
        let stem = artifact
            .file_stem()
            .map(str::to_owned)
            .unwrap_or_else(|| "report".to_owned());
        target_dir.join("stackwise").join(format!("{stem}.json"))
    });

    let build_info = BuildInfo {
        workspace_root: Some(workspace_root.to_string()),
        package: package_name,
        profile: Some(request.profile.clone()),
        target: request.target.clone(),
        features: request.features.clone(),
        exact_mode: request.exact_mode,
    };

    analyze_and_write(&artifact, build_info, json_path.clone())?;
    Ok(json_path)
}

fn build_and_capture_artifact(request: &CargoAnalysisRequest) -> anyhow::Result<Utf8PathBuf> {
    let mut command = Command::new("cargo");
    command
        .arg("build")
        .arg("--message-format=json-render-diagnostics");

    if request.profile == "release" {
        command.arg("--release");
    } else if request.profile != "dev" {
        command.arg("--profile").arg(&request.profile);
    }

    if let Some(target) = &request.target {
        command.arg("--target").arg(target);
    }
    if let Some(package) = &request.package {
        command.arg("--package").arg(package);
    }
    if request.workspace {
        command.arg("--workspace");
    }
    if let Some(bin) = &request.bin {
        command.arg("--bin").arg(bin);
    }
    if let Some(example) = &request.example {
        command.arg("--example").arg(example);
    }
    if !request.features.is_empty() {
        command.arg("--features").arg(request.features.join(","));
    }
    if request.all_features {
        command.arg("--all-features");
    }
    if request.no_default_features {
        command.arg("--no-default-features");
    }

    command.stdout(Stdio::piped()).stderr(Stdio::inherit());
    let output = command.output().context("failed to spawn cargo build")?;
    if !output.status.success() {
        bail!("cargo build failed");
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut executables = Vec::new();
    for line in stdout.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if value.get("reason").and_then(Value::as_str) != Some("compiler-artifact") {
            continue;
        }
        let is_runnable = value
            .pointer("/target/kind")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .any(|kind| kind == "bin" || kind == "example" || kind == "test");
        if !is_runnable {
            continue;
        }
        if let Some(executable) = value.get("executable").and_then(Value::as_str) {
            executables.push(Utf8PathBuf::from(executable));
        }
    }

    executables
        .into_iter()
        .last()
        .context("cargo build did not report a runnable artifact")
}

fn newest_artifact(
    target_dir: &Utf8Path,
    request: &CargoAnalysisRequest,
) -> anyhow::Result<Option<Utf8PathBuf>> {
    let profile_dir = if let Some(target) = &request.target {
        target_dir.join(target).join(&request.profile)
    } else {
        target_dir.join(&request.profile)
    };

    if !profile_dir.exists() {
        return Ok(None);
    }

    let mut newest: Option<(SystemTime, Utf8PathBuf)> = None;
    for entry in fs::read_dir(profile_dir.as_std_path())? {
        let entry = entry?;
        let path = Utf8PathBuf::from_path_buf(entry.path())
            .map_err(|path| anyhow::anyhow!("artifact path is not UTF-8: {}", path.display()))?;
        if !path.is_file() || path.extension() == Some("d") || path.extension() == Some("rlib") {
            continue;
        }
        if cfg!(windows) && path.extension() != Some("exe") {
            continue;
        }

        let modified = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);

        if newest
            .as_ref()
            .is_none_or(|(current, _)| modified > *current)
        {
            newest = Some((modified, path));
        }
    }

    Ok(newest.map(|(_, path)| path))
}
