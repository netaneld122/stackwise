use std::fs;

use anyhow::{bail, Context};
use camino::{Utf8Path, Utf8PathBuf};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StackwiseConfig {
    pub build: Option<BuildSection>,
    pub report: Option<ReportSection>,
    pub budgets: Option<BudgetSection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildSection {
    pub profile: Option<String>,
    pub exact: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReportSection {
    pub exclude_crates: Option<Vec<String>>,
    pub collapse_std: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BudgetSection {
    pub max_own_frame: Option<u64>,
    #[serde(alias = "max_known_path")]
    pub max_measured_path: Option<u64>,
    #[serde(alias = "fail_on_unknown")]
    pub fail_on_unmeasured: Option<bool>,
}

impl StackwiseConfig {
    pub fn load_from_current_dir() -> anyhow::Result<Self> {
        let path = Utf8PathBuf::from(".stackwise.toml");
        if !path.exists() {
            return Ok(Self::default());
        }
        load_config(&path)
    }
}

fn load_config(path: &Utf8Path) -> anyhow::Result<StackwiseConfig> {
    let text = fs::read_to_string(path).with_context(|| format!("failed to read {path}"))?;
    toml::from_str(&text).with_context(|| format!("failed to parse {path}"))
}

pub fn init_config() -> anyhow::Result<()> {
    let path = Utf8PathBuf::from(".stackwise.toml");
    if path.exists() {
        bail!("{path} already exists");
    }

    fs::write(path.as_std_path(), DEFAULT_CONFIG).context("failed to write .stackwise.toml")?;
    println!("Wrote .stackwise.toml");
    Ok(())
}

const DEFAULT_CONFIG: &str = r#"[build]
profile = "release"
exact = "auto"

[report]
exclude_crates = []
collapse_std = true

[budgets]
max_own_frame = 4096
max_measured_path = 16384
fail_on_unmeasured = false
"#;
