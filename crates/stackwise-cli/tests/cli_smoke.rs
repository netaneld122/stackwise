use assert_cmd::Command;
use camino::Utf8PathBuf;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Command as StdCommand, Stdio};
use std::time::{Duration, Instant};

#[test]
fn schema_command_outputs_json() {
    let mut command = Command::cargo_bin("stackwise").unwrap();
    command.arg("schema").arg("--json");
    command
        .assert()
        .success()
        .stdout(predicates::str::contains("StackwiseReport"));
}

#[test]
fn doctor_command_runs() {
    let mut command = Command::cargo_bin("stackwise").unwrap();
    command.arg("doctor");
    command
        .assert()
        .success()
        .stdout(predicates::str::contains("Stackwise doctor"));
}

#[test]
fn cargo_subcommand_analyzes_fixture_project() {
    let manifest_dir = Utf8PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let workspace_root = manifest_dir
        .parent()
        .and_then(|path| path.parent())
        .unwrap()
        .to_path_buf();
    let fixture = workspace_root.join("fixtures").join("simple-std");
    if !fixture.join("Cargo.toml").exists() {
        eprintln!("skipping fixture smoke test because fixtures are not packaged");
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let report_path = Utf8PathBuf::from_path_buf(temp.path().join("simple-std.json")).unwrap();

    let mut command = Command::cargo_bin("cargo-stackwise").unwrap();
    command
        .current_dir(fixture)
        .arg("stackwise")
        .arg("--release")
        .arg("--json")
        .arg(&report_path);
    command.assert().success();

    let report: stackwise_core::StackwiseReport =
        serde_json::from_slice(&std::fs::read(report_path).unwrap()).unwrap();

    assert!(report.summary.symbol_count > 0);
    #[cfg(windows)]
    {
        assert!(report.summary.known_frame_count > 0);
        assert!(report
            .symbols
            .iter()
            .any(|symbol| symbol.demangled.contains("stackwise_simple_std::main")));
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "stackwise.pdb_symbols"));
    }
}

#[test]
fn analyze_artifact_writes_report_without_cargo() {
    let Some(artifact) = simple_std_artifact() else {
        eprintln!("skipping artifact smoke test because fixture artifact is not built");
        return;
    };
    let temp = tempfile::tempdir().unwrap();
    let report_path = Utf8PathBuf::from_path_buf(temp.path().join("artifact.json")).unwrap();

    let mut command = Command::cargo_bin("stackwise").unwrap();
    command
        .arg("analyze")
        .arg(&artifact)
        .arg("--json")
        .arg(&report_path);
    command.assert().success();

    let report: stackwise_core::StackwiseReport =
        serde_json::from_slice(&std::fs::read(report_path).unwrap()).unwrap();

    assert!(report.summary.symbol_count > 0);
    assert_eq!(report.artifact.path, artifact.to_string());
}

#[test]
fn analyze_artifact_serve_prints_local_url() {
    let Some(artifact) = simple_std_artifact() else {
        eprintln!("skipping artifact serve smoke test because fixture artifact is not built");
        return;
    };
    let temp = tempfile::tempdir().unwrap();
    let report_path = Utf8PathBuf::from_path_buf(temp.path().join("artifact.json")).unwrap();
    let mut child = StdCommand::new(assert_cmd::cargo::cargo_bin("stackwise"))
        .arg("analyze")
        .arg(&artifact)
        .arg("--json")
        .arg(&report_path)
        .arg("--serve")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let reader = BufReader::new(stdout);
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut saw_url = false;
    for line in reader.lines() {
        let line = line.unwrap();
        if line.contains("Serving Stackwise report at http://127.0.0.1:") {
            saw_url = true;
            break;
        }
        if Instant::now() > deadline {
            break;
        }
    }
    let _ = child.kill();
    let _ = child.wait();

    assert!(saw_url, "expected --serve to print a localhost URL");
    assert!(report_path.exists());
}

#[test]
fn complex_tree_fixture_extracts_large_direct_call_graph() {
    let Some(fixture) = fixture_root("complex-tree") else {
        eprintln!("skipping complex tree fixture test because fixtures are not packaged");
        return;
    };
    let build_status = StdCommand::new("cargo")
        .arg("build")
        .arg("--release")
        .current_dir(&fixture)
        .status()
        .unwrap();
    assert!(build_status.success(), "complex tree fixture should build");
    let artifact = release_artifact(&fixture, "stackwise-complex-tree");
    assert!(artifact.exists(), "complex tree artifact should exist");

    let temp = tempfile::tempdir().unwrap();
    let report_path = Utf8PathBuf::from_path_buf(temp.path().join("complex-tree.json")).unwrap();
    let mut command = Command::cargo_bin("stackwise").unwrap();
    command
        .arg("analyze")
        .arg(&artifact)
        .arg("--json")
        .arg(&report_path);
    command.assert().success();

    let report: stackwise_core::StackwiseReport =
        serde_json::from_slice(&std::fs::read(report_path).unwrap()).unwrap();
    let by_id = report
        .symbols
        .iter()
        .map(|symbol| (symbol.id, symbol.demangled.as_str()))
        .collect::<HashMap<_, _>>();
    let generated = report
        .symbols
        .iter()
        .filter(|symbol| {
            symbol
                .demangled
                .contains("stackwise_complex_tree::generated::")
        })
        .collect::<Vec<_>>();
    let generated_measured = generated
        .iter()
        .filter(|symbol| symbol.own_frame.status == stackwise_core::FrameStatus::Known)
        .count();
    let generated_direct_edges = report
        .edges
        .iter()
        .filter(|edge| {
            edge.kind == stackwise_core::EdgeKind::DirectCall
                && by_id
                    .get(&edge.caller)
                    .is_some_and(|name| name.contains("::generated::"))
                && edge.callee.is_some_and(|callee| {
                    by_id
                        .get(&callee)
                        .is_some_and(|name| name.contains("::generated::"))
                })
        })
        .count();

    assert!(report
        .symbols
        .iter()
        .any(|symbol| symbol.demangled == "stackwise_complex_tree::main"));
    assert!(report
        .symbols
        .iter()
        .any(|symbol| symbol.demangled == "stackwise_complex_tree::generated::tree_root"));
    assert!(report
        .symbols
        .iter()
        .any(|symbol| symbol.demangled == "stackwise_complex_tree::generated::node_0_0"));
    assert!(report
        .symbols
        .iter()
        .any(|symbol| symbol.demangled == "stackwise_complex_tree::generated::node_5_1023"));
    assert!(
        generated.len() >= 1366,
        "expected the generated tree to retain at least 1366 symbols, got {}",
        generated.len()
    );
    assert!(
        generated_measured >= 1366,
        "expected every generated tree symbol to have measured frame evidence, got {generated_measured}"
    );
    assert!(
        generated_direct_edges >= 1360,
        "expected direct generated call edges from the emitted tree, got {generated_direct_edges}"
    );
    assert!(has_named_edge(
        &report,
        &by_id,
        "stackwise_complex_tree::generated::tree_root",
        "stackwise_complex_tree::generated::node_0_0",
    ));
    assert!(has_named_edge(
        &report,
        &by_id,
        "stackwise_complex_tree::generated::node_0_0",
        "stackwise_complex_tree::generated::node_1_0",
    ));
    assert!(has_named_edge(
        &report,
        &by_id,
        "stackwise_complex_tree::generated::node_4_255",
        "stackwise_complex_tree::generated::node_5_1023",
    ));
}

fn simple_std_artifact() -> Option<Utf8PathBuf> {
    let fixture = fixture_root("simple-std")?;
    let artifact = release_artifact(&fixture, "stackwise-simple-std");
    artifact.exists().then_some(artifact)
}

fn fixture_root(name: &str) -> Option<Utf8PathBuf> {
    let manifest_dir = Utf8PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let workspace_root = manifest_dir
        .parent()
        .and_then(|path| path.parent())?
        .to_path_buf();
    let fixture = workspace_root.join("fixtures").join(name);
    fixture.join("Cargo.toml").exists().then_some(fixture)
}

fn release_artifact(fixture: &Utf8PathBuf, name: &str) -> Utf8PathBuf {
    if cfg!(windows) {
        fixture
            .join("target")
            .join("release")
            .join(format!("{name}.exe"))
    } else {
        fixture.join("target").join("release").join(name)
    }
}

fn has_named_edge(
    report: &stackwise_core::StackwiseReport,
    by_id: &HashMap<u32, &str>,
    caller: &str,
    callee: &str,
) -> bool {
    report.edges.iter().any(|edge| {
        edge.kind == stackwise_core::EdgeKind::DirectCall
            && by_id.get(&edge.caller).copied() == Some(caller)
            && edge
                .callee
                .is_some_and(|callee_id| by_id.get(&callee_id).copied() == Some(callee))
    })
}
