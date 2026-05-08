# Release Checklist

Stackwise publishes two crates. Publish `stackwise-core` first, wait for the crates.io index to update, then publish `stackwise`.

Codex must never run a real publish command. Use dry-runs only:

```powershell
cargo publish --dry-run --allow-dirty -p stackwise-core
cargo publish --dry-run --allow-dirty -p stackwise
```

## Before Release

```powershell
cargo fmt --all -- --check
cargo test --workspace --target-dir target\verify
cargo clippy --workspace --all-targets --target-dir target\verify -- -D warnings
cd ui\stackwise-ui
npm test -- --run
npm run build
cd ..\..
```

If the UI build changes hashed files, copy `ui\stackwise-ui\dist\*` into `crates\stackwise-cli\assets\app\` and rerun the Rust verification.

## Package Inspection

```powershell
cargo package --allow-dirty --list -p stackwise-core
cargo package --allow-dirty --list -p stackwise
```

Confirm the CLI package includes `assets/app`, and neither package includes local/private workflow files.

## Real Publish Order

Run these manually only when intentionally releasing:

```powershell
cargo publish -p stackwise-core
# wait for crates.io index propagation
cargo publish -p stackwise
git tag v0.2.0
git push origin main --tags
```

Never publish if the working tree is dirty, verification has not passed, or the changelog/version does not match the intended release.
