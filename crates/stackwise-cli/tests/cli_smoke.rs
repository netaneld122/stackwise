use assert_cmd::Command;
use camino::Utf8PathBuf;

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
    assert!(report.summary.known_frame_count > 0);
}
