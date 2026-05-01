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
}

#[derive(Debug, Args)]
pub struct CheckCommand {
    pub report: Utf8PathBuf,

    #[arg(long)]
    pub max_own_frame: Option<u64>,

    #[arg(long)]
    pub max_known_path: Option<u64>,

    #[arg(long)]
    pub fail_on_unknown: bool,
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
