mod cargo_mode;
mod cli;
mod config;
mod progress;
mod server;

use std::ffi::OsString;
use std::fs;

use anyhow::{bail, Context};
use camino::{Utf8Path, Utf8PathBuf};
use clap::{CommandFactory, Parser};
use schemars::schema_for;
use stackwise_core::{analyze_artifact, AnalyzeOptions, BuildInfo, ExactMode, StackwiseReport};

use crate::cargo_mode::{run_cargo_analysis, CargoAnalysisRequest};
use crate::cli::{Cli, Commands, ExactModeArg};
use crate::config::StackwiseConfig;
use crate::progress::AnalysisProgress;

pub fn run<I, T>(args: I) -> anyhow::Result<()>
where
    I: IntoIterator<Item = T>,
    T: Into<OsString> + Clone,
{
    let cli = Cli::parse_from(args);

    match cli.command {
        Some(Commands::Analyze(command)) => {
            let report = match command.json.as_deref() {
                Some(path) => analyze_to_file(&command.artifact, command.build_info(), path)?,
                None => analyze_to_stdout(&command.artifact, command.build_info())?,
            };
            print_summary(&report);
        }
        Some(Commands::Open(command)) => {
            server::serve_report(command.report, !command.serve)?;
        }
        Some(Commands::Check(command)) => {
            let report = read_report(&command.report)?;
            run_check(
                &report,
                command.max_own_frame,
                command.max_measured_path,
                command.fail_on_unmeasured,
            )?;
        }
        Some(Commands::Doctor) => {
            print_doctor();
        }
        Some(Commands::Schema(command)) => {
            let schema = schema_for!(StackwiseReport);
            if command.json {
                println!("{}", serde_json::to_string_pretty(&schema)?);
            } else {
                Cli::command().print_help()?;
                println!();
            }
        }
        Some(Commands::Init) => {
            config::init_config()?;
        }
        None => {
            let config = StackwiseConfig::load_from_current_dir().unwrap_or_default();
            let report_path = run_cargo_analysis(CargoAnalysisRequest::from_cli(&cli, config)?)?;
            if cli.open || cli.serve {
                server::serve_report(report_path, cli.open)?;
            }
        }
    }

    Ok(())
}

fn write_report_to_file(report: &StackwiseReport, path: &Utf8Path) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create report directory {parent}"))?;
    }
    fs::write(path, serde_json::to_vec_pretty(report)?)
        .with_context(|| format!("failed to write report {path}"))?;
    Ok(())
}

fn read_report(path: &Utf8Path) -> anyhow::Result<StackwiseReport> {
    let data = fs::read(path).with_context(|| format!("failed to read report {path}"))?;
    serde_json::from_slice(&data).with_context(|| format!("failed to parse report {path}"))
}

fn run_check(
    report: &StackwiseReport,
    max_own_frame: Option<u64>,
    max_measured_path: Option<u64>,
    fail_on_unmeasured: bool,
) -> anyhow::Result<()> {
    let mut failures = Vec::new();

    if let Some(limit) = max_own_frame {
        for symbol in &report.symbols {
            if symbol.own_frame.bytes.is_some_and(|bytes| bytes > limit) {
                failures.push(format!(
                    "own frame {} bytes exceeds {} in {}",
                    symbol.own_frame.bytes.unwrap_or_default(),
                    limit,
                    symbol.demangled
                ));
            }
        }
    }

    if let Some(limit) = max_measured_path {
        for symbol in &report.symbols {
            if symbol.worst_path.bytes.is_some_and(|bytes| bytes > limit) {
                failures.push(format!(
                    "measured path {} bytes exceeds {} from {}",
                    symbol.worst_path.bytes.unwrap_or_default(),
                    limit,
                    symbol.demangled
                ));
            }
        }
    }

    if fail_on_unmeasured && report.summary.unknown_frame_count > 0 {
        failures.push(format!(
            "{} symbols have unmeasured frame sizes",
            report.summary.unknown_frame_count
        ));
    }

    if !failures.is_empty() {
        for failure in &failures {
            eprintln!("check failed: {failure}");
        }
        bail!("stackwise check failed with {} issue(s)", failures.len());
    }

    println!("stackwise check passed");
    Ok(())
}

pub(crate) fn print_summary(report: &StackwiseReport) {
    println!(
        "Analyzed {} symbols, {} edges, {} measured frames, {} unmeasured frames",
        report.summary.symbol_count,
        report.summary.edge_count,
        report.summary.known_frame_count,
        report.summary.unknown_frame_count
    );

    if let Some(max) = &report.summary.max_own_frame {
        println!(
            "Largest own frame: {} bytes in {}",
            max.bytes, max.demangled
        );
    }

    if let Some(max) = &report.summary.max_worst_path {
        println!(
            "Largest measured path: {} bytes from {}",
            max.bytes, max.demangled
        );
    }

    for diagnostic in &report.diagnostics {
        println!(
            "{:?}: {} - {}",
            diagnostic.level, diagnostic.code, diagnostic.message
        );
    }
}

fn print_doctor() {
    println!("Stackwise doctor");
    println!("version: {}", env!("CARGO_PKG_VERSION"));
    println!(
        "current_dir: {}",
        std::env::current_dir()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|_| "<unknown>".to_owned())
    );
    println!("rustc: {}", command_version("rustc", &["--version"]));
    println!("cargo: {}", command_version("cargo", &["--version"]));
    println!(
        "rustup nightly: {}",
        command_version("rustup", &["which", "rustc", "--toolchain", "nightly"])
    );
    println!(
        "llvm-readobj: {}",
        command_version("llvm-readobj", &["--version"])
    );
    println!("note: exact Rust stack-size metadata currently requires nightly rustc, ELF output, and preserved .stack_sizes sections.");
}

fn command_version(command: &str, args: &[&str]) -> String {
    match std::process::Command::new(command).args(args).output() {
        Ok(output) if output.status.success() => {
            let text = String::from_utf8_lossy(&output.stdout);
            text.lines().next().unwrap_or("<empty>").to_owned()
        }
        Ok(output) => {
            let text = String::from_utf8_lossy(&output.stderr);
            text.lines().next().unwrap_or("<failed>").to_owned()
        }
        Err(error) => format!("not found ({error})"),
    }
}

pub(crate) fn analyze_and_write(
    artifact: &Utf8Path,
    build: BuildInfo,
    json_path: Utf8PathBuf,
) -> anyhow::Result<StackwiseReport> {
    let exact_required = build.exact_mode == ExactMode::Required;

    let progress = AnalysisProgress::new();
    progress.set_stage("Analyzing artifact...");
    let report = analyze_artifact(artifact, AnalyzeOptions { build: Some(build) })?;
    if exact_required && report.summary.confidence != stackwise_core::Confidence::Exact {
        bail!(
            "exact stack data was required, but this artifact only produced {:?} confidence; use an ELF artifact with preserved .stack_sizes or omit --exact",
            report.summary.confidence
        );
    }

    progress.set_stage("Writing report...");
    write_report_to_file(&report, &json_path)?;
    progress.finish();

    println!("Wrote {}", json_path);
    print_summary(&report);
    Ok(report)
}

fn analyze_to_file(
    artifact: &Utf8Path,
    build: Option<BuildInfo>,
    json_path: &Utf8Path,
) -> anyhow::Result<StackwiseReport> {
    let progress = AnalysisProgress::new();
    progress.set_stage("Analyzing artifact...");
    let report = analyze_artifact(artifact, AnalyzeOptions { build })?;

    progress.set_stage("Writing report...");
    write_report_to_file(&report, json_path)?;
    progress.finish();

    println!("Wrote {}", json_path);
    Ok(report)
}

fn analyze_to_stdout(
    artifact: &Utf8Path,
    build: Option<BuildInfo>,
) -> anyhow::Result<StackwiseReport> {
    let report = analyze_artifact(artifact, AnalyzeOptions { build })?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(report)
}

pub(crate) fn exact_mode_from_arg(arg: ExactModeArg) -> ExactMode {
    match arg {
        ExactModeArg::Off => ExactMode::Off,
        ExactModeArg::Auto => ExactMode::Auto,
        ExactModeArg::Required => ExactMode::Required,
    }
}
