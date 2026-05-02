use camino::Utf8PathBuf;
use clap::{Args, Parser, Subcommand, ValueEnum};
use stackwise_core::{BuildInfo, ExactMode};

#[derive(Debug, Parser)]
#[command(name = "stackwise")]
#[command(about = "Drop-in Rust stack analyzer for emitted artifacts")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Commands>,

    #[arg(long)]
    pub release: bool,

    #[arg(long)]
    pub profile: Option<String>,

    #[arg(long)]
    pub target: Option<String>,

    #[arg(long)]
    pub features: Vec<String>,

    #[arg(long)]
    pub all_features: bool,

    #[arg(long)]
    pub no_default_features: bool,

    #[arg(long)]
    pub package: Option<String>,

    #[arg(long)]
    pub bin: Option<String>,

    #[arg(long)]
    pub example: Option<String>,

    #[arg(long)]
    pub workspace: bool,

    #[arg(long)]
    pub open: bool,

    #[arg(long, conflicts_with = "open")]
    pub serve: bool,

    #[arg(long)]
    pub json: Option<Utf8PathBuf>,

    #[arg(long)]
    pub no_build: bool,

    #[arg(
        long,
        value_enum,
        default_value_t = ExactModeArg::Auto,
        default_missing_value = "required",
        num_args = 0..=1,
        require_equals = false
    )]
    pub exact: ExactModeArg,
}

#[derive(Debug, Subcommand)]
pub enum Commands {
    Analyze(AnalyzeCommand),
    Open(OpenCommand),
    Check(CheckCommand),
    Doctor,
    Schema(SchemaCommand),
    Init,
}

#[derive(Debug, Args)]
pub struct AnalyzeCommand {
    pub artifact: Utf8PathBuf,

    #[arg(long)]
    pub json: Option<Utf8PathBuf>,

    #[arg(long)]
    pub workspace_root: Option<Utf8PathBuf>,

    #[arg(long)]
    pub profile: Option<String>,

    #[arg(long)]
    pub target: Option<String>,
}

impl AnalyzeCommand {
    pub fn build_info(&self) -> Option<BuildInfo> {
        if self.workspace_root.is_none() && self.profile.is_none() && self.target.is_none() {
            return None;
        }

        Some(BuildInfo {
            workspace_root: self.workspace_root.as_ref().map(ToString::to_string),
            package: None,
            profile: self.profile.clone(),
            target: self.target.clone(),
            features: Vec::new(),
            exact_mode: ExactMode::Off,
        })
    }
}

#[derive(Debug, Args)]
pub struct OpenCommand {
    pub report: Utf8PathBuf,

    #[arg(long)]
    pub serve: bool,
}

#[derive(Debug, Args)]
pub struct CheckCommand {
    pub report: Utf8PathBuf,

    #[arg(long)]
    pub max_own_frame: Option<u64>,

    #[arg(long = "max-measured-path", alias = "max-known-path")]
    pub max_measured_path: Option<u64>,

    #[arg(long = "fail-on-unmeasured", alias = "fail-on-unknown")]
    pub fail_on_unmeasured: bool,
}

#[derive(Debug, Args)]
pub struct SchemaCommand {
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum ExactModeArg {
    Off,
    Auto,
    Required,
}

#[cfg(test)]
mod tests {
    use super::{Cli, Commands};
    use clap::Parser;

    #[test]
    fn cargo_style_serve_mode_parses_without_opening() {
        let cli = Cli::try_parse_from(["stackwise", "--release", "--serve"]).unwrap();

        assert!(cli.release);
        assert!(cli.serve);
        assert!(!cli.open);
    }

    #[test]
    fn cargo_style_serve_conflicts_with_open() {
        assert!(Cli::try_parse_from(["stackwise", "--open", "--serve"]).is_err());
    }

    #[test]
    fn open_command_serve_mode_parses_without_opening() {
        let cli = Cli::try_parse_from(["stackwise", "open", "report.json", "--serve"]).unwrap();
        let Some(Commands::Open(command)) = cli.command else {
            panic!("expected open command");
        };

        assert_eq!(command.report.as_str(), "report.json");
        assert!(command.serve);
    }
}
