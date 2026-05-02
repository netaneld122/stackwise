# Stackwise

Stackwise is a drop-in Rust CLI for analyzing emitted stack usage from final build artifacts.

```powershell
cargo install stackwise
cargo stackwise --release --open
```

It builds or reads your artifact, writes a versioned JSON report, and serves a local interactive UI with stack treemaps, call graphs, source snippets, and disassembly.

Use `--serve` when you want the local URL without opening a browser:

```powershell
cargo stackwise --release --serve
```

The analysis engine lives in `stackwise-core`.
