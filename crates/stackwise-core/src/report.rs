use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: &str = "0.1.0";

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct StackwiseReport {
    pub schema_version: String,
    pub generator: GeneratorInfo,
    pub artifact: ArtifactInfo,
    pub build: Option<BuildInfo>,
    pub summary: Summary,
    pub symbols: Vec<SymbolReport>,
    pub edges: Vec<EdgeReport>,
    pub groups: Vec<GroupReport>,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GeneratorInfo {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ArtifactInfo {
    pub path: String,
    pub file_name: String,
    pub format: ObjectFormat,
    pub architecture: String,
    pub pointer_width: Option<u8>,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct BuildInfo {
    pub workspace_root: Option<String>,
    pub package: Option<String>,
    pub profile: Option<String>,
    pub target: Option<String>,
    pub features: Vec<String>,
    pub exact_mode: ExactMode,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExactMode {
    Off,
    Auto,
    Required,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Summary {
    pub symbol_count: usize,
    pub edge_count: usize,
    pub known_frame_count: usize,
    pub unknown_frame_count: usize,
    pub recursive_symbol_count: usize,
    pub indirect_edge_count: usize,
    pub max_own_frame: Option<SymbolMetric>,
    pub max_worst_path: Option<SymbolMetric>,
    pub confidence: Confidence,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SymbolMetric {
    pub symbol_id: u32,
    pub bytes: u64,
    pub demangled: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SymbolReport {
    pub id: u32,
    pub name: String,
    pub demangled: String,
    pub crate_name: Option<String>,
    pub module_path: Vec<String>,
    pub address: u64,
    pub size_bytes: Option<u64>,
    pub source_location: Option<SourceLocation>,
    pub object_format: ObjectFormat,
    pub own_frame: FrameInfo,
    pub worst_path: WorstPathInfo,
    pub confidence: Confidence,
    pub evidence: Vec<Evidence>,
    pub unresolved_reasons: Vec<UnresolvedReason>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FrameInfo {
    pub bytes: Option<u64>,
    pub status: FrameStatus,
    pub evidence_source: EvidenceSource,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FrameStatus {
    Known,
    Unknown,
    Dynamic,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct WorstPathInfo {
    pub bytes: Option<u64>,
    pub status: UpperBoundStatus,
    pub path: Vec<u32>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UpperBoundStatus {
    Known,
    Unknown,
    Recursive,
    Dynamic,
    Indirect,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Evidence {
    pub source: EvidenceSource,
    pub confidence: Confidence,
    pub note: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceSource {
    ElfStackSizes,
    PeUnwind,
    MachOUnwind,
    PrologueDisassembly,
    SymbolOnly,
    Unknown,
}

#[derive(
    Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq, PartialOrd, Ord,
)]
#[serde(rename_all = "snake_case")]
pub enum Confidence {
    Exact,
    High,
    Medium,
    Low,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct EdgeReport {
    pub caller: u32,
    pub callee: Option<u32>,
    pub target_address: Option<u64>,
    pub kind: EdgeKind,
    pub confidence: Confidence,
}

#[derive(
    Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq, PartialOrd, Ord,
)]
#[serde(rename_all = "snake_case")]
pub enum EdgeKind {
    DirectCall,
    TailCall,
    IndirectCall,
    ExternalCall,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GroupReport {
    pub id: u32,
    pub name: String,
    pub parent: Option<u32>,
    pub symbol_ids: Vec<u32>,
    pub own_frame_sum: Option<u64>,
    pub worst_path_max: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SourceLocation {
    pub file: String,
    pub line: Option<u32>,
    pub column: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Diagnostic {
    pub level: DiagnosticLevel,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticLevel {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ObjectFormat {
    Elf,
    PeCoff,
    MachO,
    Wasm,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UnresolvedReason {
    MissingStackEvidence,
    DynamicStackAllocation,
    RecursiveCycle,
    IndirectCall,
    ExternalCall,
    UnsupportedObjectFormat,
    StrippedSymbols,
}
