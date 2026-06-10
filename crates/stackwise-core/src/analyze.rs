use std::collections::{BTreeMap, BTreeSet};
use std::fs;

use camino::{Utf8Path, Utf8PathBuf};
use object::{Architecture, Object, ObjectSection, ObjectSymbol, SymbolKind};
use rayon::prelude::*;

use crate::elf_stack_sizes;
use crate::graph::compute_worst_paths;
use crate::pdb_symbols;
use crate::pe_unwind;
use crate::symbol_names::{crate_and_module, demangle};
use crate::{
    ArtifactInfo, BuildInfo, Confidence, Diagnostic, DiagnosticLevel, EdgeKind, EdgeReport,
    Evidence, EvidenceSource, FrameInfo, FrameStatus, GeneratorInfo, GroupReport, ObjectFormat,
    StackwiseReport, Summary, SymbolMetric, SymbolReport, UnresolvedReason, UpperBoundStatus,
    WorstPathInfo, SCHEMA_VERSION,
};

#[derive(Debug, Clone, Default)]
pub struct AnalyzeOptions {
    pub build: Option<BuildInfo>,
}

pub fn analyze_artifact(
    artifact_path: impl AsRef<Utf8Path>,
    options: AnalyzeOptions,
) -> Result<StackwiseReport, AnalyzeError> {
    let artifact_path = artifact_path.as_ref();
    let bytes = fs::read(artifact_path).map_err(|source| AnalyzeError::ReadArtifact {
        path: artifact_path.to_path_buf(),
        source,
    })?;
    let file =
        object::File::parse(bytes.as_slice()).map_err(|source| AnalyzeError::ParseObject {
            path: artifact_path.to_path_buf(),
            message: source.to_string(),
        })?;

    let format = object_format(&file);
    let architecture = format!("{:?}", file.architecture());
    let pointer_width = pointer_width(&file);
    let frame_sources = frame_sources(&file, format);

    let mut diagnostics = Vec::new();
    if frame_sources.is_empty() {
        diagnostics.push(Diagnostic {
            level: DiagnosticLevel::Warning,
            code: "stackwise.no_frame_evidence".to_owned(),
            message: "No exact stack-frame metadata was found; stack sizes are reported as unmeasured instead of fake zeroes.".to_owned(),
        });
    }

    let pdb_symbols = load_debug_symbols(artifact_path, &file, format, &mut diagnostics);
    let has_object_symbols = file.symbols().next().is_some();
    if !has_object_symbols && pdb_symbols.is_empty() {
        diagnostics.push(Diagnostic {
            level: DiagnosticLevel::Warning,
            code: "stackwise.stripped_symbols".to_owned(),
            message: "The artifact has no regular symbol table and no adjacent PDB symbols were found; try an unstripped artifact for useful symbol names.".to_owned(),
        });
    } else if !has_object_symbols {
        diagnostics.push(Diagnostic {
            level: DiagnosticLevel::Info,
            code: "stackwise.pdb_fallback_symbols".to_owned(),
            message: "The artifact has no regular symbol table; using adjacent PDB symbols for names and PE unwind ranges for frames.".to_owned(),
        });
    }

    let mut symbols = collect_symbols(&file, format, &frame_sources, &pdb_symbols);
    let edges = collect_edges(&file, &symbols);
    compute_worst_paths(&mut symbols, &edges);
    let groups = build_groups(&symbols);
    let summary = summarize(&symbols, &edges);

    Ok(StackwiseReport {
        schema_version: SCHEMA_VERSION.to_owned(),
        generator: GeneratorInfo {
            name: "stackwise".to_owned(),
            version: env!("CARGO_PKG_VERSION").to_owned(),
        },
        artifact: ArtifactInfo {
            path: artifact_path.to_string(),
            file_name: artifact_path
                .file_name()
                .map(str::to_owned)
                .unwrap_or_else(|| artifact_path.as_str().to_owned()),
            format,
            architecture,
            pointer_width,
            size_bytes: bytes.len() as u64,
        },
        build: options.build,
        summary,
        symbols,
        edges,
        groups,
        diagnostics,
    })
}

fn load_debug_symbols(
    artifact_path: &Utf8Path,
    file: &object::File<'_>,
    format: ObjectFormat,
    diagnostics: &mut Vec<Diagnostic>,
) -> Vec<pdb_symbols::PdbSymbol> {
    if format != ObjectFormat::PeCoff {
        return Vec::new();
    }

    match pdb_symbols::load_pdb_symbols(artifact_path, file) {
        Ok(Some(symbols)) => {
            diagnostics.push(Diagnostic {
                level: DiagnosticLevel::Info,
                code: "stackwise.pdb_symbols".to_owned(),
                message: format!(
                    "Loaded {} function symbols from adjacent PDB.",
                    symbols.len()
                ),
            });
            symbols
        }
        Ok(None) => Vec::new(),
        Err(error) => {
            diagnostics.push(Diagnostic {
                level: DiagnosticLevel::Warning,
                code: "stackwise.pdb_symbols_failed".to_owned(),
                message: error.to_string(),
            });
            Vec::new()
        }
    }
}

fn frame_sources(file: &object::File<'_>, format: ObjectFormat) -> BTreeMap<u64, FrameRecord> {
    match format {
        ObjectFormat::Elf => elf_stack_sizes::parse_elf_stack_sizes(file)
            .unwrap_or_default()
            .into_iter()
            .map(|(address, bytes)| {
                (
                    address,
                    FrameRecord {
                        bytes,
                        end: None,
                        source: EvidenceSource::ElfStackSizes,
                        confidence: Confidence::Exact,
                        note: "Read from ELF .stack_sizes metadata emitted by LLVM.".to_owned(),
                    },
                )
            })
            .collect(),
        ObjectFormat::PeCoff if matches!(file.architecture(), Architecture::X86_64) => {
            pe_unwind::parse_pe_x64_unwind(file)
                .into_iter()
                .map(|record| {
                    (
                        record.begin,
                        FrameRecord {
                            bytes: record.stack_bytes,
                            end: Some(record.end),
                            source: EvidenceSource::PeUnwind,
                            confidence: Confidence::High,
                            note: "Recovered from PE x64 unwind metadata.".to_owned(),
                        },
                    )
                })
                .collect()
        }
        _ => BTreeMap::new(),
    }
}

fn collect_symbols(
    file: &object::File<'_>,
    format: ObjectFormat,
    frames: &BTreeMap<u64, FrameRecord>,
    debug_symbols: &[pdb_symbols::PdbSymbol],
) -> Vec<SymbolReport> {
    let mut raw_by_address = BTreeMap::<u64, RawSymbol>::new();

    for symbol in file
        .symbols()
        .filter(|symbol| symbol.is_definition())
        .filter(|symbol| symbol.kind() == SymbolKind::Text)
        .filter(|symbol| symbol.address() != 0 || symbol.size() != 0)
        .filter(|symbol| !symbol.name().unwrap_or_default().is_empty())
    {
        raw_by_address
            .entry(symbol.address())
            .or_insert_with(|| RawSymbol {
                name: symbol.name().unwrap_or_default().to_owned(),
                address: symbol.address(),
                size: symbol.size(),
                source_location: None,
            });
    }

    for symbol in debug_symbols {
        raw_by_address.insert(
            symbol.address,
            RawSymbol {
                name: symbol.name.clone(),
                address: symbol.address,
                size: symbol.size,
                source_location: symbol.source_location.clone(),
            },
        );
    }

    for (address, frame) in frames {
        raw_by_address.entry(*address).or_insert_with(|| RawSymbol {
            name: format!("sub_{address:016x}"),
            address: *address,
            size: frame
                .end
                .and_then(|end| end.checked_sub(*address))
                .unwrap_or_default(),
            source_location: None,
        });
    }

    let mut raw = raw_by_address.into_values().collect::<Vec<_>>();
    for symbol in &mut raw {
        if symbol.size == 0 {
            symbol.size = frames
                .get(&symbol.address)
                .and_then(|frame| frame.end)
                .and_then(|end| end.checked_sub(symbol.address))
                .unwrap_or_default();
        }
    }

    raw.into_par_iter()
        .enumerate()
        .map(|(index, raw)| {
            let demangled = demangle(&raw.name);
            let (crate_name, module_path) = crate_and_module(&demangled);
            let frame = lookup_frame(raw.address, frames);
            let mut unresolved_reasons = Vec::new();
            let (own_frame, evidence, confidence) = match frame {
                Some(frame) => (
                    FrameInfo {
                        bytes: Some(frame.bytes),
                        status: FrameStatus::Known,
                        evidence_source: frame.source,
                    },
                    vec![Evidence {
                        source: frame.source,
                        confidence: frame.confidence,
                        note: frame.note.clone(),
                    }],
                    frame.confidence,
                ),
                None => {
                    unresolved_reasons.push(UnresolvedReason::MissingStackEvidence);
                    (
                        FrameInfo {
                            bytes: None,
                            status: FrameStatus::Unknown,
                            evidence_source: EvidenceSource::SymbolOnly,
                        },
                        vec![Evidence {
                            source: EvidenceSource::SymbolOnly,
                            confidence: Confidence::Unknown,
                            note: "Symbol was found, but no stack-frame evidence was available for it.".to_owned(),
                        }],
                        Confidence::Unknown,
                    )
                }
            };

            SymbolReport {
                id: index as u32,
                name: raw.name,
                demangled,
                crate_name,
                module_path,
                address: raw.address,
                size_bytes: (raw.size > 0).then_some(raw.size),
                source_location: raw.source_location,
                object_format: format,
                own_frame,
                worst_path: WorstPathInfo {
                    bytes: None,
                    status: UpperBoundStatus::Unknown,
                    path: Vec::new(),
                },
                confidence,
                evidence,
                unresolved_reasons,
            }
        })
        .collect()
}

fn lookup_frame(address: u64, frames: &BTreeMap<u64, FrameRecord>) -> Option<&FrameRecord> {
    frames.get(&address)
}

fn collect_edges(file: &object::File<'_>, symbols: &[SymbolReport]) -> Vec<EdgeReport> {
    let executable_sections = file
        .sections()
        .filter(|section| section.kind() == object::SectionKind::Text)
        .filter_map(|section| {
            section.data().ok().map(|data| SectionBytes {
                address: section.address(),
                data,
            })
        })
        .collect::<Vec<_>>();

    let ranges = symbols
        .iter()
        .filter_map(|symbol| {
            let size = symbol.size_bytes?;
            Some((
                symbol.address,
                symbol.address.saturating_add(size),
                symbol.id,
            ))
        })
        .collect::<Vec<_>>();

    let mut edges = Vec::new();
    let mut seen = BTreeSet::new();

    for symbol in symbols {
        let Some(size) = symbol.size_bytes else {
            continue;
        };
        let Some(bytes) = symbol_bytes(symbol.address, size, &executable_sections) else {
            continue;
        };
        let body_end = symbol.address.saturating_add(size);

        for call in scan_x86_direct_calls(symbol.address, bytes) {
            if is_intra_symbol_branch(call.target, symbol.address, body_end) {
                continue;
            }
            let callee = resolve_symbol(call.target, &ranges);
            let kind = match (call.kind, callee) {
                (ScannedEdgeKind::Call, Some(_)) => EdgeKind::DirectCall,
                (ScannedEdgeKind::Jump, Some(_)) => EdgeKind::TailCall,
                (ScannedEdgeKind::IndirectCall, _) => EdgeKind::IndirectCall,
                (_, None) => EdgeKind::ExternalCall,
            };

            let key = (symbol.id, callee, call.target, kind);
            if seen.insert(key) {
                edges.push(EdgeReport {
                    caller: symbol.id,
                    callee,
                    target_address: call.target,
                    kind,
                    confidence: Confidence::Medium,
                });
            }
        }
    }

    edges
}

fn symbol_bytes<'a>(address: u64, size: u64, sections: &'a [SectionBytes<'a>]) -> Option<&'a [u8]> {
    sections.iter().find_map(|section| {
        let offset = address.checked_sub(section.address)? as usize;
        let size = usize::try_from(size).ok()?;
        section.data.get(offset..offset.checked_add(size)?)
    })
}

fn scan_x86_direct_calls(base: u64, bytes: &[u8]) -> Vec<ScannedEdge> {
    let mut edges = Vec::new();
    let mut index = 0usize;

    while index < bytes.len() {
        let opcode = bytes[index];
        match opcode {
            0xe8 | 0xe9 if index + 5 <= bytes.len() => {
                let rel = i32::from_le_bytes([
                    bytes[index + 1],
                    bytes[index + 2],
                    bytes[index + 3],
                    bytes[index + 4],
                ]);
                let next_ip = base + index as u64 + 5;
                let target = next_ip.wrapping_add_signed(i64::from(rel));
                edges.push(ScannedEdge {
                    target: Some(target),
                    kind: if opcode == 0xe8 {
                        ScannedEdgeKind::Call
                    } else {
                        ScannedEdgeKind::Jump
                    },
                });
                index += 5;
            }
            0xff if index + 2 <= bytes.len() => {
                let reg = (bytes[index + 1] >> 3) & 0b111;
                if reg == 2 || reg == 4 {
                    edges.push(ScannedEdge {
                        target: None,
                        kind: ScannedEdgeKind::IndirectCall,
                    });
                }
                index += 2;
            }
            _ => index += 1,
        }
    }

    edges
}

/// A branch back into the symbol's own body (anywhere past the entry point)
/// is intra-function control flow, not a call edge; treating it as a tail
/// call would falsely mark the function recursive. A real self call or self
/// tail call targets the entry address and is kept.
fn is_intra_symbol_branch(target: Option<u64>, start: u64, end: u64) -> bool {
    target.is_some_and(|target| target > start && target < end)
}

fn resolve_symbol(address: Option<u64>, ranges: &[(u64, u64, u32)]) -> Option<u32> {
    let address = address?;
    ranges
        .iter()
        .find(|(start, end, _)| address >= *start && address < *end)
        .map(|(_, _, id)| *id)
}

fn build_groups(symbols: &[SymbolReport]) -> Vec<GroupReport> {
    let mut by_name: BTreeMap<String, Vec<u32>> = BTreeMap::new();
    for symbol in symbols {
        let module_path = symbol
            .module_path
            .iter()
            .map(|part| part.trim())
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>();
        let group = if module_path.is_empty() {
            symbol
                .crate_name
                .as_deref()
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .unwrap_or("(unknown)")
                .to_owned()
        } else {
            module_path.join("::")
        };
        by_name.entry(group).or_default().push(symbol.id);
    }

    by_name
        .into_iter()
        .enumerate()
        .map(|(index, (name, symbol_ids))| {
            let own_frame_sum = symbol_ids
                .iter()
                .map(|id| symbols[*id as usize].own_frame.bytes)
                .try_fold(0u64, |sum, value| value.map(|bytes| sum + bytes));
            let worst_path_max = symbol_ids
                .iter()
                .filter_map(|id| symbols[*id as usize].worst_path.bytes)
                .max();

            GroupReport {
                id: index as u32,
                name,
                parent: None,
                symbol_ids,
                own_frame_sum,
                worst_path_max,
            }
        })
        .collect()
}

fn summarize(symbols: &[SymbolReport], edges: &[EdgeReport]) -> Summary {
    let known_frame_count = symbols
        .iter()
        .filter(|symbol| symbol.own_frame.status == FrameStatus::Known)
        .count();
    let recursive_symbol_count = symbols
        .iter()
        .filter(|symbol| symbol.worst_path.status == UpperBoundStatus::Recursive)
        .count();
    let indirect_edge_count = edges
        .iter()
        .filter(|edge| edge.kind == EdgeKind::IndirectCall)
        .count();

    Summary {
        symbol_count: symbols.len(),
        edge_count: edges.len(),
        known_frame_count,
        unknown_frame_count: symbols.len().saturating_sub(known_frame_count),
        recursive_symbol_count,
        indirect_edge_count,
        max_own_frame: max_own_frame(symbols),
        max_worst_path: max_worst_path(symbols),
        confidence: summary_confidence(symbols, known_frame_count),
    }
}

fn summary_confidence(symbols: &[SymbolReport], known_frame_count: usize) -> Confidence {
    if symbols.is_empty() || known_frame_count == 0 {
        return Confidence::Unknown;
    }

    if known_frame_count != symbols.len() {
        return Confidence::Medium;
    }

    if symbols
        .iter()
        .all(|symbol| symbol.confidence == Confidence::Exact)
    {
        Confidence::Exact
    } else if symbols
        .iter()
        .all(|symbol| matches!(symbol.confidence, Confidence::Exact | Confidence::High))
    {
        Confidence::High
    } else {
        Confidence::Medium
    }
}

fn max_own_frame(symbols: &[SymbolReport]) -> Option<SymbolMetric> {
    symbols
        .iter()
        .filter_map(|symbol| symbol.own_frame.bytes.map(|bytes| (symbol, bytes)))
        .max_by_key(|(_, bytes)| *bytes)
        .map(|(symbol, bytes)| SymbolMetric {
            symbol_id: symbol.id,
            bytes,
            demangled: symbol.demangled.clone(),
        })
}

fn max_worst_path(symbols: &[SymbolReport]) -> Option<SymbolMetric> {
    symbols
        .iter()
        .filter_map(|symbol| symbol.worst_path.bytes.map(|bytes| (symbol, bytes)))
        .max_by_key(|(_, bytes)| *bytes)
        .map(|(symbol, bytes)| SymbolMetric {
            symbol_id: symbol.id,
            bytes,
            demangled: symbol.demangled.clone(),
        })
}

fn object_format(file: &object::File<'_>) -> ObjectFormat {
    match file.format() {
        object::BinaryFormat::Elf => ObjectFormat::Elf,
        object::BinaryFormat::Coff | object::BinaryFormat::Pe => ObjectFormat::PeCoff,
        object::BinaryFormat::MachO => ObjectFormat::MachO,
        object::BinaryFormat::Wasm => ObjectFormat::Wasm,
        _ => ObjectFormat::Unknown,
    }
}

fn pointer_width(file: &object::File<'_>) -> Option<u8> {
    if file.is_64() {
        Some(64)
    } else {
        Some(32)
    }
}

#[derive(Debug, Clone)]
struct FrameRecord {
    bytes: u64,
    end: Option<u64>,
    source: EvidenceSource,
    confidence: Confidence,
    note: String,
}

#[derive(Debug)]
struct RawSymbol {
    name: String,
    address: u64,
    size: u64,
    source_location: Option<crate::SourceLocation>,
}

#[derive(Debug)]
struct SectionBytes<'a> {
    address: u64,
    data: &'a [u8],
}

#[derive(Debug)]
struct ScannedEdge {
    target: Option<u64>,
    kind: ScannedEdgeKind,
}

#[derive(Debug, Clone, Copy)]
enum ScannedEdgeKind {
    Call,
    Jump,
    IndirectCall,
}

#[cfg(test)]
mod tests {
    use super::{is_intra_symbol_branch, scan_x86_direct_calls};

    #[test]
    fn intra_function_jumps_are_filtered_but_outward_calls_are_kept() {
        let bytes = [
            0xe9, 0x05, 0x00, 0x00, 0x00, // jmp rel32 -> base + 10 (inside the body)
            0xe8, 0xf6, 0x00, 0x00, 0x00, // call rel32 -> base + 0x100 (outside the body)
            0x90, 0x90,
        ];
        let base = 0x1000u64;
        let end = base + bytes.len() as u64;

        let flagged = scan_x86_direct_calls(base, &bytes)
            .iter()
            .map(|edge| (edge.target, is_intra_symbol_branch(edge.target, base, end)))
            .collect::<Vec<_>>();

        assert_eq!(flagged, [(Some(0x100a), true), (Some(0x1100), false)]);
    }

    #[test]
    fn branches_to_the_entry_or_outside_the_body_are_not_intra_symbol() {
        assert!(!is_intra_symbol_branch(Some(0x1000), 0x1000, 0x1010));
        assert!(is_intra_symbol_branch(Some(0x1001), 0x1000, 0x1010));
        assert!(!is_intra_symbol_branch(Some(0x1010), 0x1000, 0x1010));
        assert!(!is_intra_symbol_branch(None, 0x1000, 0x1010));
    }
}

#[derive(Debug, thiserror::Error)]
pub enum AnalyzeError {
    #[error("failed to read artifact {path}: {source}")]
    ReadArtifact {
        path: Utf8PathBuf,
        source: std::io::Error,
    },
    #[error("failed to parse object file {path}: {message}")]
    ParseObject { path: Utf8PathBuf, message: String },
}
