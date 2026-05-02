use std::collections::{BTreeMap, BTreeSet};

use crate::{EdgeKind, EdgeReport, FrameStatus, SymbolReport, UnresolvedReason, UpperBoundStatus};

pub fn compute_worst_paths(symbols: &mut [SymbolReport], edges: &[EdgeReport]) {
    let mut adjacency: BTreeMap<u32, Vec<CallTarget>> = BTreeMap::new();
    let mut indirect_callers = BTreeSet::new();

    for edge in edges {
        match edge.kind {
            EdgeKind::DirectCall | EdgeKind::TailCall => {
                if let Some(callee) = edge.callee {
                    adjacency.entry(edge.caller).or_default().push(CallTarget {
                        callee,
                        kind: edge.kind,
                    });
                }
            }
            EdgeKind::IndirectCall => {
                indirect_callers.insert(edge.caller);
            }
            EdgeKind::ExternalCall => {}
        }
    }

    let by_id = symbols
        .iter()
        .enumerate()
        .map(|(index, symbol)| (symbol.id, index))
        .collect::<BTreeMap<_, _>>();

    let mut memo = BTreeMap::new();
    for symbol in symbols.iter() {
        let mut visiting = BTreeSet::new();
        let result = visit(
            symbol.id,
            symbols,
            &by_id,
            &adjacency,
            &mut memo,
            &mut visiting,
        );
        memo.insert(symbol.id, result);
    }

    for symbol in symbols.iter_mut() {
        let Some(result) = memo.get(&symbol.id).cloned() else {
            continue;
        };

        let status =
            if indirect_callers.contains(&symbol.id) && result.status == UpperBoundStatus::Known {
                UpperBoundStatus::Indirect
            } else {
                result.status
            };

        if indirect_callers.contains(&symbol.id) {
            push_reason(symbol, UnresolvedReason::IndirectCall);
        }

        symbol.worst_path.bytes = result.bytes;
        symbol.worst_path.status = status;
        symbol.worst_path.path = result.path;

        if status == UpperBoundStatus::Recursive {
            push_reason(symbol, UnresolvedReason::RecursiveCycle);
        }
    }
}

fn visit(
    id: u32,
    symbols: &[SymbolReport],
    by_id: &BTreeMap<u32, usize>,
    adjacency: &BTreeMap<u32, Vec<CallTarget>>,
    memo: &mut BTreeMap<u32, PathResult>,
    visiting: &mut BTreeSet<u32>,
) -> PathResult {
    if let Some(result) = memo.get(&id) {
        return result.clone();
    }

    if !visiting.insert(id) {
        return PathResult {
            bytes: None,
            status: UpperBoundStatus::Recursive,
            path: vec![id],
        };
    }

    let own = by_id
        .get(&id)
        .and_then(|index| symbols.get(*index))
        .and_then(|symbol| match symbol.own_frame.status {
            FrameStatus::Known => symbol.own_frame.bytes,
            FrameStatus::Dynamic => None,
            FrameStatus::Unknown => None,
        });

    let own_status = by_id
        .get(&id)
        .and_then(|index| symbols.get(*index))
        .map(|symbol| symbol.own_frame.status)
        .unwrap_or(FrameStatus::Unknown);

    if own_status == FrameStatus::Dynamic {
        visiting.remove(&id);
        return PathResult {
            bytes: None,
            status: UpperBoundStatus::Dynamic,
            path: vec![id],
        };
    }

    if own.is_none() {
        visiting.remove(&id);
        return PathResult {
            bytes: None,
            status: UpperBoundStatus::Unknown,
            path: vec![id],
        };
    }

    let mut best_child: Option<PathResult> = None;
    for target in adjacency.get(&id).into_iter().flatten().copied() {
        let result = visit(target.callee, symbols, by_id, adjacency, memo, visiting);
        if result.status != UpperBoundStatus::Known {
            visiting.remove(&id);
            return PathResult {
                bytes: None,
                status: result.status,
                path: prepend(id, result.path),
            };
        }

        let candidate_bytes = result.bytes.map(|bytes| match target.kind {
            EdgeKind::TailCall => bytes.max(own.unwrap_or_default()),
            EdgeKind::DirectCall => bytes + own.unwrap_or_default(),
            EdgeKind::IndirectCall | EdgeKind::ExternalCall => bytes,
        });
        let candidate = PathResult {
            bytes: candidate_bytes,
            status: UpperBoundStatus::Known,
            path: result.path,
        };

        if best_child.as_ref().and_then(|current| current.bytes) < candidate.bytes {
            best_child = Some(candidate);
        }
    }

    visiting.remove(&id);

    let own_bytes = own.unwrap_or_default();
    match best_child {
        Some(child) => PathResult {
            bytes: child.bytes,
            status: UpperBoundStatus::Known,
            path: prepend(id, child.path),
        },
        None => PathResult {
            bytes: Some(own_bytes),
            status: UpperBoundStatus::Known,
            path: vec![id],
        },
    }
}

fn prepend(id: u32, mut path: Vec<u32>) -> Vec<u32> {
    path.insert(0, id);
    path
}

fn push_reason(symbol: &mut SymbolReport, reason: UnresolvedReason) {
    if !symbol.unresolved_reasons.contains(&reason) {
        symbol.unresolved_reasons.push(reason);
    }
}

#[derive(Debug, Clone)]
struct PathResult {
    bytes: Option<u64>,
    status: UpperBoundStatus,
    path: Vec<u32>,
}

#[derive(Debug, Clone, Copy)]
struct CallTarget {
    callee: u32,
    kind: EdgeKind,
}

#[cfg(test)]
mod tests {
    use crate::{
        graph::compute_worst_paths, Confidence, EdgeKind, EdgeReport, EvidenceSource, FrameInfo,
        FrameStatus, ObjectFormat, SymbolReport, UpperBoundStatus, WorstPathInfo,
    };

    #[test]
    fn computes_known_worst_path() {
        let mut symbols = vec![symbol(0, 10), symbol(1, 20), symbol(2, 5)];
        let edges = vec![
            edge(0, Some(1), EdgeKind::DirectCall),
            edge(1, Some(2), EdgeKind::DirectCall),
        ];

        compute_worst_paths(&mut symbols, &edges);

        assert_eq!(symbols[0].worst_path.bytes, Some(35));
        assert_eq!(symbols[0].worst_path.status, UpperBoundStatus::Known);
        assert_eq!(symbols[0].worst_path.path, [0, 1, 2]);
    }

    #[test]
    fn marks_recursive_path() {
        let mut symbols = vec![symbol(0, 10), symbol(1, 20)];
        let edges = vec![
            edge(0, Some(1), EdgeKind::DirectCall),
            edge(1, Some(0), EdgeKind::DirectCall),
        ];

        compute_worst_paths(&mut symbols, &edges);

        assert_eq!(symbols[0].worst_path.status, UpperBoundStatus::Recursive);
    }

    #[test]
    fn tail_calls_do_not_add_frames() {
        let mut symbols = vec![symbol(0, 64), symbol(1, 128)];
        let edges = vec![edge(0, Some(1), EdgeKind::TailCall)];

        compute_worst_paths(&mut symbols, &edges);

        assert_eq!(symbols[0].worst_path.bytes, Some(128));
        assert_eq!(symbols[0].worst_path.path, [0, 1]);
    }

    fn symbol(id: u32, frame: u64) -> SymbolReport {
        SymbolReport {
            id,
            name: format!("s{id}"),
            demangled: format!("s{id}"),
            crate_name: None,
            module_path: Vec::new(),
            address: u64::from(id) * 16,
            size_bytes: Some(16),
            source_location: None,
            object_format: ObjectFormat::Elf,
            own_frame: FrameInfo {
                bytes: Some(frame),
                status: FrameStatus::Known,
                evidence_source: EvidenceSource::ElfStackSizes,
            },
            worst_path: WorstPathInfo {
                bytes: None,
                status: UpperBoundStatus::Unknown,
                path: Vec::new(),
            },
            confidence: Confidence::Exact,
            evidence: Vec::new(),
            unresolved_reasons: Vec::new(),
        }
    }

    fn edge(caller: u32, callee: Option<u32>, kind: EdgeKind) -> EdgeReport {
        EdgeReport {
            caller,
            callee,
            target_address: None,
            kind,
            confidence: Confidence::Medium,
        }
    }
}
