# Changelog

All notable changes to Stackwise will be documented in this file.

## 0.3.1 - 2026-05-16

- Fixed "Show worst path" so backend-reported worst-path descendants stay visible even when the call graph node limit would otherwise prune them.
- Fixed call graph node selection so selecting different nodes no longer promotes React Flow's internal root selection state.
- Fixed call graph search filtering so the default root and details panel stay aligned with the visible filtered symbols.

## 0.3.0 - 2026-05-15

- Optimized large treemap and call graph interactions, including treemap hit testing, call graph pruning, reachability counts, and graph layout label placement.
- Improved call graph navigation with stronger root/minimap cues, exact symbol focus centering, Ctrl+Z/Ctrl+Shift+Z undo/redo, and a hidden-caller hint for roots with callers outside the current view.
- Added a clear source/disassembly fallback message when a symbol context response is empty.
- Expanded regression coverage for large graphs, treemap scaling, minimap root markers, hidden caller reveal behavior, and cross-view centering.

## 0.2.0 - 2026-05-09

- Added direct artifact UI serving with `stackwise analyze <artifact> --open` and `--serve`.
- Improved the call graph with unified node limits, reveal markers, root pin/unpin actions, minimap fixes, and treemap cross-navigation.
- Added complex call-graph fixture coverage and stronger UI regression tests.
- Polished the treemap, module counts, source/disassembly panes, and embedded UI assets.

## 0.1.0 - 2026-05-08

- Initial crates.io release candidate.
- Drop-in `cargo stackwise` workflow for existing Rust projects.
- Artifact analysis for PE/COFF unwind data and ELF `.stack_sizes`.
- Versioned JSON reports, CI budget checks, and local interactive UI.
- Stack treemap, call graph, source view, disassembly view, and AI handoff helpers.
