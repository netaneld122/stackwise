# Changelog

All notable changes to Stackwise will be documented in this file.

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
