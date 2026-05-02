#[cfg(windows)]
use std::ffi::OsString;
use std::fs;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Context;
use camino::Utf8PathBuf;
use iced_x86::{Decoder, DecoderOptions, Formatter, NasmFormatter};
use include_dir::{include_dir, Dir, File};
use object::{Object, ObjectSection};
use serde::{Deserialize, Serialize};
use stackwise_core::{EdgeReport, SourceLocation, StackwiseReport, SymbolReport};
use tiny_http::{Header, Method, Response, Server, StatusCode};

pub fn serve_report(report_path: Utf8PathBuf, open_browser: bool) -> anyhow::Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").context("failed to bind local UI server")?;
    let address = listener.local_addr()?;
    drop(listener);

    let server = Server::http(address).map_err(|error| anyhow::anyhow!("{error}"))?;
    let url = format!("http://{address}/");
    println!("Serving Stackwise report at {url}");

    if open_browser {
        let _ = open::that(&url);
    }

    for mut request in server.incoming_requests() {
        let method = request.method().clone();
        let url = request.url().to_owned();

        let response = match (method, url.as_str()) {
            (Method::Get, "/report.json") | (Method::Get, "/api/report") => {
                match fs::read(report_path.as_std_path()) {
                    Ok(data) => json_response(data),
                    Err(error) => {
                        text_response(StatusCode(500), format!("failed to read report: {error}"))
                    }
                }
            }
            (Method::Get, url) if url.starts_with("/api/symbol-context") => {
                symbol_context_response(&report_path, url)
            }
            (Method::Get, url) if url.starts_with("/api/source-file") => {
                source_file_response(&report_path, url)
            }
            (Method::Get, url) if url.starts_with("/api/agent-handoff-status") => {
                agent_handoff_status_response(&report_path, url)
            }
            (Method::Post, "/api/agent-handoff") => {
                let mut body = String::new();
                let _ = request.as_reader().read_to_string(&mut body);
                agent_handoff_response(&report_path, &body)
            }
            (Method::Post, "/api/open-source") => {
                let mut body = String::new();
                let _ = request.as_reader().read_to_string(&mut body);
                text_response(
                    StatusCode(501),
                    "editor integration is not enabled in this build".to_owned(),
                )
            }
            (Method::Get, url) => ui_asset_response(url),
            _ => text_response(StatusCode(404), "not found".to_owned()),
        };

        let _ = request.respond(response);
        thread::yield_now();
    }

    Ok(())
}

fn json_response(data: Vec<u8>) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_data(data).with_header(content_type("application/json"))
}

fn json_value_response(value: &impl Serialize) -> Response<std::io::Cursor<Vec<u8>>> {
    json_response(serde_json::to_vec(value).unwrap_or_default())
}

fn text_response(status: StatusCode, text: String) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_string(text)
        .with_status_code(status)
        .with_header(content_type("text/plain; charset=utf-8"))
}

fn ui_asset_response(url: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    let Some(path) = ui_asset_path(url) else {
        return text_response(StatusCode(404), "not found".to_owned());
    };
    let Some(file) = UI_ASSETS.get_file(&path) else {
        return text_response(StatusCode(404), "not found".to_owned());
    };
    asset_response(file)
}

fn ui_asset_path(url: &str) -> Option<String> {
    let path = url.split('?').next().unwrap_or("/");
    if path == "/" || path == "/index.html" {
        return Some("index.html".to_owned());
    }

    let relative = path.trim_start_matches('/').replace('\\', "/");
    if relative.is_empty()
        || relative
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return None;
    }
    Some(relative)
}

fn asset_response(file: &File<'_>) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_data(file.contents().to_vec()).with_header(content_type(mime_for_path(
        file.path().to_string_lossy().as_ref(),
    )))
}

fn mime_for_path(path: &str) -> &'static str {
    match Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
    {
        Some("html") => "text/html; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("map") => "application/json",
        _ => "application/octet-stream",
    }
}

fn symbol_context_response(
    report_path: &Utf8PathBuf,
    url: &str,
) -> Response<std::io::Cursor<Vec<u8>>> {
    let Some(id) = query_param(url, "id").and_then(|value| value.parse::<u32>().ok()) else {
        return text_response(StatusCode(400), "missing symbol id".to_owned());
    };

    let report = match fs::read(report_path.as_std_path())
        .ok()
        .and_then(|data| serde_json::from_slice::<StackwiseReport>(&data).ok())
    {
        Some(report) => report,
        None => return text_response(StatusCode(500), "failed to read report".to_owned()),
    };

    let Some(symbol) = report.symbols.iter().find(|symbol| symbol.id == id) else {
        return text_response(StatusCode(404), "symbol not found".to_owned());
    };

    let source = source_snippet(symbol, &report);
    let disassembly = disassemble_symbol(symbol, &report);
    let mut messages = Vec::new();
    if source.is_none() {
        match &symbol.source_location {
            Some(location) => {
                let mut message = format!(
                    "Source location was recorded as {}, but Stackwise could not read the file.",
                    location.file
                );
                if rust_library_relative_path(&location.file).is_some() {
                    message.push_str(
                        " Install or update local Rust sources with `rustup component add rust-src` for the active toolchain.",
                    );
                }
                messages.push(message);
            }
            None => messages.push("No source location was available for this symbol.".to_owned()),
        }
    }
    if disassembly.is_none() {
        messages.push("Disassembly was unavailable for this symbol or architecture.".to_owned());
    }

    json_response(
        serde_json::to_vec(&SymbolContext {
            source,
            disassembly,
            messages,
        })
        .unwrap_or_default(),
    )
}

fn source_file_response(
    report_path: &Utf8PathBuf,
    url: &str,
) -> Response<std::io::Cursor<Vec<u8>>> {
    let Some(id) = query_param(url, "id").and_then(|value| value.parse::<u32>().ok()) else {
        return text_response(StatusCode(400), "missing symbol id".to_owned());
    };

    let report = match fs::read(report_path.as_std_path())
        .ok()
        .and_then(|data| serde_json::from_slice::<StackwiseReport>(&data).ok())
    {
        Some(report) => report,
        None => return text_response(StatusCode(500), "failed to read report".to_owned()),
    };

    let Some(symbol) = report.symbols.iter().find(|symbol| symbol.id == id) else {
        return text_response(StatusCode(404), "symbol not found".to_owned());
    };

    let source = source_file(symbol, &report);
    let mut messages = Vec::new();
    if source.is_none() {
        messages.push("Full source file was unavailable for this symbol.".to_owned());
    }

    json_response(serde_json::to_vec(&SourceFileContext { source, messages }).unwrap_or_default())
}

fn agent_handoff_status_response(
    report_path: &Utf8PathBuf,
    url: &str,
) -> Response<std::io::Cursor<Vec<u8>>> {
    let Some(id) = query_param(url, "id") else {
        return text_response(StatusCode(400), "missing handoff id".to_owned());
    };
    let Some(status_path) = agent_handoff_status_path(report_path, &id) else {
        return text_response(StatusCode(400), "invalid handoff id".to_owned());
    };
    let status = match read_agent_status(&status_path) {
        Ok(status) => status,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return text_response(StatusCode(404), "handoff status not found".to_owned());
        }
        Err(error) => {
            return text_response(
                StatusCode(500),
                format!("failed to read handoff status: {error}"),
            );
        }
    };

    json_value_response(&enrich_agent_status(status))
}

fn agent_handoff_response(
    report_path: &Utf8PathBuf,
    body: &str,
) -> Response<std::io::Cursor<Vec<u8>>> {
    let request = match serde_json::from_str::<AgentHandoffRequest>(body) {
        Ok(request) => request,
        Err(error) => {
            return text_response(
                StatusCode(400),
                format!("invalid agent handoff request: {error}"),
            );
        }
    };

    let report = match fs::read(report_path.as_std_path())
        .ok()
        .and_then(|data| serde_json::from_slice::<StackwiseReport>(&data).ok())
    {
        Some(report) => report,
        None => return text_response(StatusCode(500), "failed to read report".to_owned()),
    };

    let Some(symbol) = report
        .symbols
        .iter()
        .find(|symbol| symbol.id == request.symbol_id)
    else {
        return text_response(StatusCode(404), "symbol not found".to_owned());
    };

    let source = source_snippet(symbol, &report);
    let disassembly = disassemble_symbol(symbol, &report);
    let handoff_dir = agent_handoff_dir(report_path);
    if let Err(error) = fs::create_dir_all(&handoff_dir) {
        return text_response(
            StatusCode(500),
            format!("failed to create agent handoff directory: {error}"),
        );
    }

    let handoff_id = format!(
        "{}-{}-{}",
        unix_timestamp(),
        request.agent.slug(),
        sanitize_file_component(&symbol.demangled)
    );
    let context_path = handoff_dir.join(format!("{handoff_id}.context.json"));
    let prompt_path = handoff_dir.join(format!("{handoff_id}.prompt.md"));
    let script_path = handoff_dir.join(format!("{handoff_id}{}", shell_script_extension()));
    let status_path = handoff_dir.join(format!("{handoff_id}.status.json"));
    let log_path = handoff_dir.join(format!("{handoff_id}.log"));
    let context = build_agent_handoff_context(report_path, &report, symbol, source, disassembly);
    let prompt = build_agent_prompt(request.agent, &context, &context_path);

    let context_json = match serde_json::to_vec_pretty(&context) {
        Ok(data) => data,
        Err(error) => {
            return text_response(
                StatusCode(500),
                format!("failed to serialize agent context: {error}"),
            );
        }
    };
    if let Err(error) = fs::write(&context_path, context_json) {
        return text_response(
            StatusCode(500),
            format!("failed to write agent context: {error}"),
        );
    }
    if let Err(error) = fs::write(&prompt_path, prompt) {
        return text_response(
            StatusCode(500),
            format!("failed to write agent prompt: {error}"),
        );
    }
    if let Err(error) = write_agent_script(AgentScriptConfig {
        script_path: &script_path,
        agent: request.agent,
        handoff_id: &handoff_id,
        prompt_path: &prompt_path,
        context_path: &context_path,
        status_path: &status_path,
        log_path: &log_path,
        report: &report,
    }) {
        return text_response(
            StatusCode(500),
            format!("failed to write agent launch script: {error}"),
        );
    }
    let running_status = AgentHandoffStatus::running(
        &handoff_id,
        request.agent,
        &prompt_path,
        &context_path,
        &script_path,
        &log_path,
    );
    if let Err(error) = write_agent_status(&status_path, &running_status) {
        return text_response(
            StatusCode(500),
            format!("failed to write agent status: {error}"),
        );
    }
    if let Err(error) = launch_agent_shell(&script_path, request.agent) {
        let failed_status = AgentHandoffStatus::failed(
            &handoff_id,
            request.agent,
            None,
            format!("failed to launch {}: {error}", request.agent.label()),
            None,
            AgentHandoffPaths {
                prompt_path: &prompt_path,
                context_path: &context_path,
                script_path: &script_path,
                log_path: &log_path,
            },
        );
        let _ = write_agent_status(&status_path, &failed_status);
        return text_response(
            StatusCode(500),
            format!("failed to launch {}: {error}", request.agent.label()),
        );
    }

    json_value_response(&AgentHandoffResponse {
        agent: request.agent.label(),
        handoff_id,
        prompt_path: prompt_path.to_string_lossy().to_string(),
        context_path: context_path.to_string_lossy().to_string(),
        script_path: script_path.to_string_lossy().to_string(),
        status_path: status_path.to_string_lossy().to_string(),
        log_path: log_path.to_string_lossy().to_string(),
        command: request
            .agent
            .command_preview(&agent_prompt_for_path(&prompt_path)),
        message: format!(
            "Started {} with a Stackwise stack-optimization brief.",
            request.agent.label()
        ),
    })
}

fn agent_prompt_for_path(prompt_path: &Path) -> String {
    format!(
        "Read the Stackwise optimization brief at {} and follow it.",
        prompt_path.display()
    )
}

#[cfg(not(windows))]
fn agent_prompt_command(agent: AgentKind, prompt: &str) -> String {
    match agent {
        AgentKind::Codex => format!(
            "{} exec {}",
            shell_quote(agent.program()),
            shell_quote(prompt)
        ),
        AgentKind::Opencode => format!(
            "{} run {}",
            shell_quote(agent.program()),
            shell_quote(prompt)
        ),
        _ => format!(
            "{} -p {}",
            shell_quote(agent.program()),
            shell_quote(prompt)
        ),
    }
}

#[cfg(windows)]
fn windows_agent_prompt_command(agent: AgentKind) -> String {
    match agent {
        AgentKind::Codex => "codex exec \"%STACKWISE_PROMPT%\"".to_owned(),
        AgentKind::Opencode => "opencode run \"%STACKWISE_PROMPT%\"".to_owned(),
        _ => format!("{} -p \"%STACKWISE_PROMPT%\"", agent.program()),
    }
}

#[cfg(windows)]
fn windows_agent_status_command(initial_state: AgentHandoffState) -> String {
    let body = match initial_state {
        AgentHandoffState::Running => {
            "$payload = [ordered]@{ id = $env:STACKWISE_HANDOFF_ID; agent = $env:STACKWISE_AGENT; state = 'running'; exit_code = $null; message = ($env:STACKWISE_AGENT + ' is running. Prompt: ' + $env:STACKWISE_PROMPT_FILE); log_tail = $null; prompt_path = $env:STACKWISE_PROMPT_FILE; context_path = $env:STACKWISE_CONTEXT_FILE; script_path = $env:STACKWISE_SCRIPT_FILE; log_path = $env:STACKWISE_LOG_FILE; updated_at = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() }; $json = $payload | ConvertTo-Json -Compress; [System.IO.File]::WriteAllText($env:STACKWISE_STATUS_FILE, $json, (New-Object System.Text.UTF8Encoding $false))"
        }
        AgentHandoffState::Succeeded | AgentHandoffState::Failed => {
            "$exitCode = [int]$env:STACKWISE_EXIT_CODE; $log = if (Test-Path -LiteralPath $env:STACKWISE_LOG_FILE) { [string](Get-Content -LiteralPath $env:STACKWISE_LOG_FILE -Raw) } else { '' }; $tail = if ($log.Length -gt 4000) { $log.Substring($log.Length - 4000) } else { [string]$log }; $state = if ($exitCode -eq 0) { 'succeeded' } else { 'failed' }; $message = if ($exitCode -eq 0) { $env:STACKWISE_AGENT + ' finished successfully.' } else { $env:STACKWISE_AGENT + ' exited with code ' + $exitCode + '. See the handoff log.' }; $payload = [ordered]@{ id = $env:STACKWISE_HANDOFF_ID; agent = $env:STACKWISE_AGENT; state = $state; exit_code = $exitCode; message = $message; log_tail = $tail; prompt_path = $env:STACKWISE_PROMPT_FILE; context_path = $env:STACKWISE_CONTEXT_FILE; script_path = $env:STACKWISE_SCRIPT_FILE; log_path = $env:STACKWISE_LOG_FILE; updated_at = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() }; $json = $payload | ConvertTo-Json -Compress; [System.IO.File]::WriteAllText($env:STACKWISE_STATUS_FILE, $json, (New-Object System.Text.UTF8Encoding $false))"
        }
    };
    format!("powershell -NoProfile -ExecutionPolicy Bypass -Command \"{body}\"")
}

impl AgentKind {
    fn command_preview(self, prompt: &str) -> String {
        match self {
            AgentKind::Codex => format!("{} exec \"{}\"", self.program(), prompt),
            AgentKind::Opencode => format!("{} run \"{}\"", self.program(), prompt),
            _ => format!("{} -p \"{}\"", self.program(), prompt),
        }
    }
}

fn query_param(url: &str, name: &str) -> Option<String> {
    let (_, query) = url.split_once('?')?;
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (key == name).then(|| percent_decode(value))
    })
}

fn percent_decode(value: &str) -> String {
    let mut bytes = Vec::with_capacity(value.len());
    let input = value.as_bytes();
    let mut index = 0;
    while index < input.len() {
        if input[index] == b'%' && index + 2 < input.len() {
            if let Ok(hex) = u8::from_str_radix(&value[index + 1..index + 3], 16) {
                bytes.push(hex);
                index += 3;
                continue;
            }
        }
        bytes.push(if input[index] == b'+' {
            b' '
        } else {
            input[index]
        });
        index += 1;
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

fn build_agent_handoff_context(
    report_path: &Utf8PathBuf,
    report: &StackwiseReport,
    symbol: &SymbolReport,
    source: Option<SourceSnippet>,
    disassembly: Option<DisassemblyView>,
) -> AgentHandoffContext {
    let callers = report
        .edges
        .iter()
        .filter(|edge| edge.callee == Some(symbol.id))
        .take(48)
        .map(|edge| AgentGraphEdgeContext {
            edge: edge.clone(),
            symbol: report
                .symbols
                .iter()
                .find(|candidate| candidate.id == edge.caller)
                .cloned(),
        })
        .collect();
    let callees = report
        .edges
        .iter()
        .filter(|edge| edge.caller == symbol.id)
        .take(48)
        .map(|edge| AgentGraphEdgeContext {
            edge: edge.clone(),
            symbol: edge.callee.and_then(|callee| {
                report
                    .symbols
                    .iter()
                    .find(|candidate| candidate.id == callee)
                    .cloned()
            }),
        })
        .collect();
    let worst_path = symbol
        .worst_path
        .path
        .iter()
        .filter_map(|id| report.symbols.iter().find(|candidate| candidate.id == *id))
        .take(64)
        .cloned()
        .collect();

    AgentHandoffContext {
        report_path: report_path.to_string(),
        artifact_path: report.artifact.path.clone(),
        workspace_root: report
            .build
            .as_ref()
            .and_then(|build| build.workspace_root.clone()),
        symbol: symbol.clone(),
        callers,
        callees,
        worst_path,
        source,
        disassembly,
    }
}

fn build_agent_prompt(
    agent: AgentKind,
    context: &AgentHandoffContext,
    context_path: &Path,
) -> String {
    let source_location = context
        .symbol
        .source_location
        .as_ref()
        .map(|location| {
            let line_suffix = location
                .line
                .map(|line| format!(":{line}"))
                .unwrap_or_default();
            format!("{}{line_suffix}", location.file)
        })
        .unwrap_or_else(|| "unknown".to_owned());
    let source_block = context
        .source
        .as_ref()
        .map(source_snippet_markdown)
        .unwrap_or_else(|| "Source snippet unavailable.".to_owned());
    let disassembly_block = context
        .disassembly
        .as_ref()
        .map(disassembly_markdown)
        .unwrap_or_else(|| "Disassembly unavailable.".to_owned());
    let agent_label = agent.label();
    let report_path = context.report_path.as_str();
    let context_path = context_path.display();
    let artifact_path = context.artifact_path.as_str();
    let workspace_root = context.workspace_root.as_deref().unwrap_or("unknown");
    let symbol_id = context.symbol.id;
    let demangled = context.symbol.demangled.as_str();
    let raw_name = context.symbol.name.as_str();
    let crate_name = context.symbol.crate_name.as_deref().unwrap_or("unknown");
    let module_path = context.symbol.module_path.join("::");
    let own_frame = format_optional_bytes(context.symbol.own_frame.bytes);
    let worst_path = format_optional_bytes(context.symbol.worst_path.bytes);
    let worst_status = format!("{:?}", context.symbol.worst_path.status);
    let confidence = format!("{:?}", context.symbol.confidence);
    let evidence = context
        .symbol
        .evidence
        .iter()
        .map(|item| format!("{:?}:{:?}: {}", item.source, item.confidence, item.note))
        .collect::<Vec<_>>()
        .join("; ");
    let unresolved = context
        .symbol
        .unresolved_reasons
        .iter()
        .map(|reason| format!("{reason:?}"))
        .collect::<Vec<_>>()
        .join(", ");
    let callers = graph_edges_markdown(&context.callers);
    let callees = graph_edges_markdown(&context.callees);
    let worst_path_symbols = symbols_markdown(&context.worst_path);

    format!(
        r#"# Stackwise Stack Optimization Brief

You are {agent_label}, launched from Stackwise for a focused stack optimization pass.

## Required Inputs

- Full Stackwise report JSON: `{report_path}`
- Selected-symbol context JSON: `{context_path}`
- The full report JSON contains the call graph in the top-level `edges` array.
- Artifact path: `{artifact_path}`
- Workspace root: `{workspace_root}`

## Target Function

- Symbol id: `{symbol_id}`
- Demangled: `{demangled}`
- Mangled/raw: `{raw_name}`
- Crate: `{crate_name}`
- Module path: `{module_path}`
- Source link: `{source_location}`
- Own frame: `{own_frame}`
- Worst path: `{worst_path}`
- Worst path status: `{worst_status}`
- Confidence: `{confidence}`
- Evidence: `{evidence}`
- Unresolved reasons: `{unresolved}`

## Task

Optimize stack usage for this function without changing program behavior.

1. Read the selected-symbol context JSON first, then inspect the full Stackwise report JSON when you need more call graph context.
2. Focus on this exact emitted symbol and its Rust implementation when source is available.
3. Look for large stack locals, arrays, by-value temporaries, missed boxing opportunities, recursion, inlining decisions, and call paths that amplify stack use.
4. Preserve Rust idioms and existing project style. Prefer small, reviewable patches and tests.
5. If the source is unavailable or the symbol belongs to std/core/compiler/runtime code, explain what would need to change upstream or in caller code.
6. Before changing code, state the stack hypothesis, the expected stack impact, and the validation command you will run.
7. After any change, rerun Stackwise or the closest available tests and compare the selected symbol's frame/path metrics.

## Direct Callers

{callers}

## Direct Callees

{callees}

## Worst Known Path

{worst_path_symbols}

## Source Snippet

{source_block}

## Disassembly

{disassembly_block}
"#
    )
}

fn source_snippet_markdown(source: &SourceSnippet) -> String {
    let line_suffix = source
        .line
        .map(|line| format!(":{line}"))
        .unwrap_or_default();
    let mut text = format!("`{}{line_suffix}`\n\n```{}\n", source.file, source.language);
    for line in &source.lines {
        text.push_str(&format!("{:>5}  {}\n", line.number, line.text));
    }
    text.push_str("```");
    text
}

fn disassembly_markdown(disassembly: &DisassemblyView) -> String {
    let mut text = format!(
        "Architecture: `{}`; syntax: `{}`\n\n```asm\n",
        disassembly.architecture, disassembly.syntax
    );
    for line in &disassembly.instructions {
        text.push_str(&format!(
            "{}  {:<24} {}\n",
            line.address, line.bytes, line.text
        ));
    }
    text.push_str("```");
    text
}

fn graph_edges_markdown(edges: &[AgentGraphEdgeContext]) -> String {
    if edges.is_empty() {
        return "- none resolved".to_owned();
    }
    edges
        .iter()
        .map(|edge| {
            let symbol = edge
                .symbol
                .as_ref()
                .map(|symbol| {
                    format!(
                        "{} (id {}, own {}, worst {})",
                        symbol.demangled,
                        symbol.id,
                        format_optional_bytes(symbol.own_frame.bytes),
                        format_optional_bytes(symbol.worst_path.bytes)
                    )
                })
                .unwrap_or_else(|| {
                    edge.edge
                        .target_address
                        .map(|address| format!("unresolved target at 0x{address:x}"))
                        .unwrap_or_else(|| "unresolved target".to_owned())
                });
            format!(
                "- {:?} / {:?}: {symbol}",
                edge.edge.kind, edge.edge.confidence
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn symbols_markdown(symbols: &[SymbolReport]) -> String {
    if symbols.is_empty() {
        return "- no known worst path symbols".to_owned();
    }
    symbols
        .iter()
        .map(|symbol| {
            format!(
                "- id {}: {} | own {} | worst {} | status {:?}",
                symbol.id,
                symbol.demangled,
                format_optional_bytes(symbol.own_frame.bytes),
                format_optional_bytes(symbol.worst_path.bytes),
                symbol.worst_path.status
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn format_optional_bytes(value: Option<u64>) -> String {
    value
        .map(|bytes| format!("{bytes} B"))
        .unwrap_or_else(|| "unknown".to_owned())
}

fn write_agent_status(path: &Path, status: &AgentHandoffStatus) -> anyhow::Result<()> {
    fs::write(path, serde_json::to_vec_pretty(status)?)?;
    Ok(())
}

fn read_agent_status(path: &Path) -> std::io::Result<AgentHandoffStatus> {
    let data = fs::read(path)?;
    serde_json::from_slice(&data)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
}

fn enrich_agent_status(mut status: AgentHandoffStatus) -> AgentHandoffStatus {
    if status.state == AgentHandoffState::Failed {
        if let Some(message) = friendly_agent_failure_message(
            status.agent_kind(),
            status.log_tail.as_deref().unwrap_or_default(),
            status.exit_code,
        ) {
            status.message = message;
        }
    }
    status
}

fn friendly_agent_failure_message(
    agent: Option<AgentKind>,
    log: &str,
    exit_code: Option<i32>,
) -> Option<String> {
    let normalized = log.to_lowercase();
    if agent == Some(AgentKind::Claude)
        && (normalized.contains("does not have access to claude")
            || normalized.contains("please login again")
            || normalized.contains("contact your administrator"))
    {
        return Some(
            "Claude is unavailable for this account. Try Codex, Cursor, or OpenCode, or log into Claude with an organization that has access.".to_owned(),
        );
    }

    if normalized.contains("not recognized as an internal or external command")
        || normalized.contains("command not found")
    {
        let label = agent.map(AgentKind::label).unwrap_or("Agent");
        return Some(format!(
            "{label} is not installed or is not on PATH. The Stackwise prompt was still generated and can be reused manually."
        ));
    }

    exit_code.map(|code| {
        let label = agent.map(AgentKind::label).unwrap_or("Agent");
        format!("{label} exited with code {code}. See the handoff log for details.")
    })
}

fn agent_handoff_dir(report_path: &Utf8PathBuf) -> PathBuf {
    report_path
        .as_std_path()
        .parent()
        .map(|parent| parent.join("stackwise-agent-handoffs"))
        .unwrap_or_else(|| PathBuf::from("stackwise-agent-handoffs"))
}

fn agent_handoff_status_path(report_path: &Utf8PathBuf, id: &str) -> Option<PathBuf> {
    is_safe_handoff_id(id).then(|| agent_handoff_dir(report_path).join(format!("{id}.status.json")))
}

fn is_safe_handoff_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 160
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

fn sanitize_file_component(value: &str) -> String {
    let mut output = String::new();
    let mut last_dash = false;
    for ch in value.chars() {
        let next = if ch.is_ascii_alphanumeric() {
            last_dash = false;
            Some(ch.to_ascii_lowercase())
        } else if !last_dash {
            last_dash = true;
            Some('-')
        } else {
            None
        };
        if let Some(ch) = next {
            output.push(ch);
        }
        if output.len() >= 72 {
            break;
        }
    }
    let output = output.trim_matches('-');
    if output.is_empty() {
        "symbol".to_owned()
    } else {
        output.to_owned()
    }
}

fn shell_script_extension() -> &'static str {
    if cfg!(windows) {
        ".cmd"
    } else {
        ".sh"
    }
}

struct AgentScriptConfig<'a> {
    script_path: &'a Path,
    agent: AgentKind,
    handoff_id: &'a str,
    prompt_path: &'a Path,
    context_path: &'a Path,
    status_path: &'a Path,
    log_path: &'a Path,
    report: &'a StackwiseReport,
}

fn write_agent_script(config: AgentScriptConfig<'_>) -> anyhow::Result<()> {
    let AgentScriptConfig {
        script_path,
        agent,
        handoff_id,
        prompt_path,
        context_path,
        status_path,
        log_path,
        report,
    } = config;
    let prompt = agent_prompt_for_path(prompt_path);
    let cwd = report
        .build
        .as_ref()
        .and_then(|build| build.workspace_root.as_deref())
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."));

    #[cfg(windows)]
    {
        let running_status = windows_agent_status_command(AgentHandoffState::Running);
        let final_status = windows_agent_status_command(AgentHandoffState::Failed);
        let script = format!(
            "@echo off\r\nsetlocal EnableExtensions\r\ncd /d \"{}\"\r\nset \"STACKWISE_HANDOFF_ID={}\"\r\nset \"STACKWISE_AGENT={}\"\r\nset \"STACKWISE_PROMPT={}\"\r\nset \"STACKWISE_PROMPT_FILE={}\"\r\nset \"STACKWISE_CONTEXT_FILE={}\"\r\nset \"STACKWISE_SCRIPT_FILE={}\"\r\nset \"STACKWISE_STATUS_FILE={}\"\r\nset \"STACKWISE_LOG_FILE={}\"\r\necho Stackwise launching {} for stack optimization...\r\necho Prompt: \"%STACKWISE_PROMPT_FILE%\"\r\n{}\r\ncall {} > \"%STACKWISE_LOG_FILE%\" 2>&1\r\nset \"STACKWISE_EXIT_CODE=%ERRORLEVEL%\"\r\ntype \"%STACKWISE_LOG_FILE%\"\r\n{}\r\nif not \"%STACKWISE_EXIT_CODE%\"==\"0\" (\r\n  if /I \"%STACKWISE_AGENT%\"==\"Claude\" (\r\n    findstr /I /C:\"does not have access to Claude\" /C:\"Please login again\" /C:\"contact your administrator\" \"%STACKWISE_LOG_FILE%\" >nul && echo Claude is unavailable for this account. Try Codex, Cursor, or OpenCode, or log into Claude with an organization that has access.\r\n  )\r\n)\r\necho.\r\necho Agent exited with %STACKWISE_EXIT_CODE%.\r\n",
            escape_batch_quoted(&cwd.to_string_lossy()),
            escape_batch_env(handoff_id),
            agent.label(),
            escape_batch_env(&prompt),
            escape_batch_env(&prompt_path.to_string_lossy()),
            escape_batch_env(&context_path.to_string_lossy()),
            escape_batch_env(&script_path.to_string_lossy()),
            escape_batch_env(&status_path.to_string_lossy()),
            escape_batch_env(&log_path.to_string_lossy()),
            agent.label(),
            running_status,
            windows_agent_prompt_command(agent),
            final_status
        );
        fs::write(script_path, script)?;
    }
    #[cfg(not(windows))]
    {
        let script = format!(
            "#!/usr/bin/env sh\ncd {}\nSTACKWISE_HANDOFF_ID={}\nSTACKWISE_AGENT={}\nSTACKWISE_PROMPT_FILE={}\nSTACKWISE_CONTEXT_FILE={}\nSTACKWISE_SCRIPT_FILE={}\nSTACKWISE_STATUS_FILE={}\nSTACKWISE_LOG_FILE={}\nexport STACKWISE_HANDOFF_ID STACKWISE_AGENT STACKWISE_PROMPT_FILE STACKWISE_CONTEXT_FILE STACKWISE_SCRIPT_FILE STACKWISE_STATUS_FILE STACKWISE_LOG_FILE\nprintf '%s\\n' {}\nprintf '{{\"id\":\"%s\",\"agent\":\"%s\",\"state\":\"running\",\"exit_code\":null,\"message\":\"%s is running.\",\"log_tail\":null,\"prompt_path\":\"%s\",\"context_path\":\"%s\",\"script_path\":\"%s\",\"log_path\":\"%s\",\"updated_at\":0}}\\n' \"$STACKWISE_HANDOFF_ID\" \"$STACKWISE_AGENT\" \"$STACKWISE_AGENT\" \"$STACKWISE_PROMPT_FILE\" \"$STACKWISE_CONTEXT_FILE\" \"$STACKWISE_SCRIPT_FILE\" \"$STACKWISE_LOG_FILE\" > \"$STACKWISE_STATUS_FILE\"\n{} > \"$STACKWISE_LOG_FILE\" 2>&1\nSTACKWISE_EXIT_CODE=$?\ncat \"$STACKWISE_LOG_FILE\"\nif [ \"$STACKWISE_EXIT_CODE\" -eq 0 ]; then STACKWISE_STATE=succeeded; STACKWISE_MESSAGE=\"$STACKWISE_AGENT finished successfully.\"; else STACKWISE_STATE=failed; STACKWISE_MESSAGE=\"$STACKWISE_AGENT exited with code $STACKWISE_EXIT_CODE. See the handoff log.\"; fi\nSTACKWISE_LOG_TAIL=$(tail -c 4000 \"$STACKWISE_LOG_FILE\" | sed 's/\\\\/\\\\\\\\/g; s/\"/\\\\\"/g')\nprintf '{{\"id\":\"%s\",\"agent\":\"%s\",\"state\":\"%s\",\"exit_code\":%s,\"message\":\"%s\",\"log_tail\":\"%s\",\"prompt_path\":\"%s\",\"context_path\":\"%s\",\"script_path\":\"%s\",\"log_path\":\"%s\",\"updated_at\":0}}\\n' \"$STACKWISE_HANDOFF_ID\" \"$STACKWISE_AGENT\" \"$STACKWISE_STATE\" \"$STACKWISE_EXIT_CODE\" \"$STACKWISE_MESSAGE\" \"$STACKWISE_LOG_TAIL\" \"$STACKWISE_PROMPT_FILE\" \"$STACKWISE_CONTEXT_FILE\" \"$STACKWISE_SCRIPT_FILE\" \"$STACKWISE_LOG_FILE\" > \"$STACKWISE_STATUS_FILE\"\nprintf '\\nAgent exited with %s.\\n' \"$STACKWISE_EXIT_CODE\"\n",
            shell_quote(&cwd.to_string_lossy()),
            shell_quote(handoff_id),
            shell_quote(agent.label()),
            shell_quote(&prompt_path.to_string_lossy()),
            shell_quote(&context_path.to_string_lossy()),
            shell_quote(&script_path.to_string_lossy()),
            shell_quote(&status_path.to_string_lossy()),
            shell_quote(&log_path.to_string_lossy()),
            shell_quote(&format!(
                "Stackwise launching {} for stack optimization...",
                agent.label()
            )),
            agent_prompt_command(agent, &prompt)
        );
        fs::write(script_path, script)?;
        make_executable(script_path)?;
    }

    Ok(())
}

#[cfg(windows)]
fn escape_batch_env(value: &str) -> String {
    value
        .replace('%', "%%")
        .replace(['\r', '\n'], " ")
        .replace('"', "'")
}

#[cfg(windows)]
fn escape_batch_quoted(value: &str) -> String {
    value.replace('"', "\"\"")
}

#[cfg(not(windows))]
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(all(not(windows), unix))]
fn make_executable(path: &Path) -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = fs::metadata(path)?.permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions)?;
    Ok(())
}

#[cfg(all(not(windows), not(unix)))]
fn make_executable(_path: &Path) -> anyhow::Result<()> {
    Ok(())
}

fn launch_agent_shell(script_path: &Path, agent: AgentKind) -> anyhow::Result<()> {
    let _ = agent;

    #[cfg(windows)]
    {
        Command::new("cmd")
            .args(windows_agent_shell_args(script_path))
            .spawn()
            .context("failed to start cmd")?;
        Ok(())
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(script_path)
            .spawn()
            .context("failed to open Terminal script")?;
        Ok(())
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        for terminal in [
            "x-terminal-emulator",
            "gnome-terminal",
            "konsole",
            "alacritty",
            "xterm",
        ] {
            if Command::new(terminal)
                .arg("-e")
                .arg(script_path)
                .spawn()
                .is_ok()
            {
                return Ok(());
            }
        }
        anyhow::bail!("no supported terminal emulator found");
    }

    #[cfg(not(any(windows, unix)))]
    anyhow::bail!("agent shell launch is not supported on this platform");
}

#[cfg(windows)]
fn windows_agent_shell_args(script_path: &Path) -> [OsString; 6] {
    [
        OsString::from("/C"),
        OsString::from("start"),
        OsString::from(""),
        OsString::from("cmd"),
        OsString::from("/C"),
        script_path.as_os_str().to_os_string(),
    ]
}

fn source_snippet(symbol: &SymbolReport, report: &StackwiseReport) -> Option<SourceSnippet> {
    source_view(symbol, report, SourceViewMode::Function)
}

fn source_file(symbol: &SymbolReport, report: &StackwiseReport) -> Option<SourceSnippet> {
    source_view(symbol, report, SourceViewMode::FullFile)
}

fn source_view(
    symbol: &SymbolReport,
    report: &StackwiseReport,
    mode: SourceViewMode,
) -> Option<SourceSnippet> {
    let location = symbol.source_location.as_ref()?;
    let path = resolve_source_path(location, report)?;
    let text = fs::read_to_string(&path).ok()?;
    let lines = text.lines().collect::<Vec<_>>();
    if lines.is_empty() {
        return None;
    }

    let highlight_line = location.line.unwrap_or(1).clamp(1, lines.len() as u32);
    let (start, end) = match mode {
        SourceViewMode::Function => function_span(&lines, highlight_line as usize - 1),
        SourceViewMode::FullFile => (0, lines.len()),
    };

    Some(SourceSnippet {
        file: path.display().to_string(),
        line: Some(highlight_line),
        start_line: start as u32 + 1,
        language: source_language(&path),
        lines: lines[start..end]
            .iter()
            .enumerate()
            .map(|(offset, text)| {
                let number = start as u32 + offset as u32 + 1;
                SourceLine {
                    number,
                    text: (*text).to_owned(),
                    highlight: number == highlight_line,
                }
            })
            .collect(),
    })
}

#[derive(Clone, Copy)]
enum SourceViewMode {
    Function,
    FullFile,
}

fn resolve_source_path(location: &SourceLocation, report: &StackwiseReport) -> Option<PathBuf> {
    let raw = PathBuf::from(&location.file);
    if raw.is_file() {
        return Some(raw);
    }

    if let Some(path) = resolve_rust_std_source_path(&location.file) {
        return Some(path);
    }

    let workspace_root = report
        .build
        .as_ref()
        .and_then(|build| build.workspace_root.as_deref())
        .map(PathBuf::from);
    if let Some(root) = workspace_root {
        let candidate = root.join(&location.file);
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    let artifact_parent = Path::new(&report.artifact.path).parent()?;
    let candidate = artifact_parent.join(&location.file);
    candidate.is_file().then_some(candidate)
}

fn resolve_rust_std_source_path(file: &str) -> Option<PathBuf> {
    resolve_rust_std_source_path_with_roots(file, rust_src_roots().iter().cloned())
}

fn resolve_rust_std_source_path_with_roots<I>(file: &str, roots: I) -> Option<PathBuf>
where
    I: IntoIterator<Item = PathBuf>,
{
    let relative = rust_library_relative_path(file)?;
    roots
        .into_iter()
        .map(|root| root.join(&relative))
        .find(|candidate| candidate.is_file())
}

fn rust_library_relative_path(file: &str) -> Option<PathBuf> {
    let normalized = file.replace('\\', "/");
    if !(normalized.starts_with("/rustc/")
        || normalized.starts_with("rustc/")
        || normalized.contains(":/rustc/"))
    {
        return None;
    }
    let (_, suffix) = normalized.split_once("/library/")?;
    let mut relative = PathBuf::new();
    for part in suffix.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return None;
        }
        relative.push(part);
    }
    (!relative.as_os_str().is_empty()).then_some(relative)
}

fn rust_src_roots() -> &'static [PathBuf] {
    static ROOTS: OnceLock<Vec<PathBuf>> = OnceLock::new();
    ROOTS.get_or_init(|| {
        let mut roots = Vec::new();
        if let Some(sysroot) = rustc_sysroot() {
            push_unique(
                &mut roots,
                sysroot
                    .join("lib")
                    .join("rustlib")
                    .join("src")
                    .join("rust")
                    .join("library"),
            );
        }

        if let Some(rustup_home) = rustup_home() {
            let toolchains = rustup_home.join("toolchains");
            if let Ok(toolchain) = std::env::var("RUSTUP_TOOLCHAIN") {
                push_unique(
                    &mut roots,
                    toolchains
                        .join(toolchain)
                        .join("lib")
                        .join("rustlib")
                        .join("src")
                        .join("rust")
                        .join("library"),
                );
            }
            if let Ok(entries) = fs::read_dir(toolchains) {
                for entry in entries.flatten() {
                    let Ok(file_type) = entry.file_type() else {
                        continue;
                    };
                    if file_type.is_dir() {
                        push_unique(
                            &mut roots,
                            entry
                                .path()
                                .join("lib")
                                .join("rustlib")
                                .join("src")
                                .join("rust")
                                .join("library"),
                        );
                    }
                }
            }
        }

        roots
    })
}

fn push_unique(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.iter().any(|existing| existing == &path) {
        paths.push(path);
    }
}

fn rustc_sysroot() -> Option<PathBuf> {
    static SYSROOT: OnceLock<Option<PathBuf>> = OnceLock::new();
    SYSROOT
        .get_or_init(|| {
            let output = Command::new("rustc")
                .args(["--print", "sysroot"])
                .output()
                .ok()?;
            if !output.status.success() {
                return None;
            }
            let text = String::from_utf8(output.stdout).ok()?;
            let path = PathBuf::from(text.trim());
            (!path.as_os_str().is_empty()).then_some(path)
        })
        .clone()
}

fn rustup_home() -> Option<PathBuf> {
    std::env::var_os("RUSTUP_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(|home| PathBuf::from(home).join(".rustup")))
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".rustup")))
}

fn source_language(path: &Path) -> String {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some("rs") => "rust",
        Some("c") | Some("h") => "c",
        Some("cc") | Some("cpp") | Some("cxx") | Some("hpp") => "cpp",
        Some("s") | Some("S") | Some("asm") => "asm",
        _ => "text",
    }
    .to_owned()
}

fn function_span(lines: &[&str], highlight: usize) -> (usize, usize) {
    let fallback_start = highlight.saturating_sub(14);
    let fallback_end = (highlight + 36).min(lines.len());
    let Some(mut start) = (0..=highlight)
        .rev()
        .find(|index| looks_like_function_start(lines[*index]))
    else {
        return (fallback_start, fallback_end);
    };

    while start > 0 {
        let previous = lines[start - 1].trim_start();
        if previous.starts_with("#[") || previous.starts_with("///") || previous.is_empty() {
            start -= 1;
        } else {
            break;
        }
    }

    let mut depth = 0i32;
    let mut saw_open = false;
    for (index, line) in lines.iter().enumerate().skip(start).take(180) {
        for ch in line.chars() {
            match ch {
                '{' => {
                    saw_open = true;
                    depth += 1;
                }
                '}' if saw_open => depth -= 1,
                _ => {}
            }
        }
        if saw_open && depth <= 0 {
            return (start, index + 1);
        }
    }

    (start, fallback_end)
}

fn looks_like_function_start(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with("fn ")
        || trimmed.starts_with("pub fn ")
        || trimmed.starts_with("pub(crate) fn ")
        || trimmed.starts_with("pub(super) fn ")
        || trimmed.starts_with("unsafe fn ")
        || trimmed.contains(" fn ")
}

fn disassemble_symbol(symbol: &SymbolReport, report: &StackwiseReport) -> Option<DisassemblyView> {
    let size = symbol.size_bytes.unwrap_or(256).clamp(1, 4096);
    let bytes = fs::read(&report.artifact.path).ok()?;
    let file = object::File::parse(bytes.as_slice()).ok()?;
    if !matches!(
        file.architecture(),
        object::Architecture::X86_64 | object::Architecture::I386
    ) {
        return None;
    }

    let code = symbol_bytes(&file, symbol.address, size)?;
    let bitness = if file.is_64() { 64 } else { 32 };
    let mut decoder = Decoder::with_ip(bitness, code, symbol.address, DecoderOptions::NONE);
    let mut formatter = NasmFormatter::new();
    let mut formatted = String::new();
    let mut instructions = Vec::new();

    while decoder.can_decode() && instructions.len() < 256 {
        let instruction = decoder.decode();
        formatted.clear();
        formatter.format(&instruction, &mut formatted);
        let offset = instruction.ip().saturating_sub(symbol.address) as usize;
        let len = instruction.len().min(code.len().saturating_sub(offset));
        let bytes = code
            .get(offset..offset + len)
            .unwrap_or_default()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<Vec<_>>()
            .join(" ");
        instructions.push(InstructionLine {
            address: format!("0x{:x}", instruction.ip()),
            bytes,
            text: formatted.clone(),
        });
    }

    (!instructions.is_empty()).then_some(DisassemblyView {
        architecture: format!("{:?}", file.architecture()),
        syntax: "nasm".to_owned(),
        instructions,
    })
}

fn symbol_bytes<'data>(file: &object::File<'data>, address: u64, size: u64) -> Option<&'data [u8]> {
    file.sections()
        .filter(|section| section.kind() == object::SectionKind::Text)
        .find_map(|section| {
            let section_data = section.data().ok()?;
            let offset = address.checked_sub(section.address())? as usize;
            let size = usize::try_from(size).ok()?;
            section_data.get(offset..offset.checked_add(size)?)
        })
}

#[derive(Debug, Deserialize)]
struct AgentHandoffRequest {
    agent: AgentKind,
    symbol_id: u32,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum AgentKind {
    Claude,
    Codex,
    Cursor,
    Opencode,
}

impl AgentKind {
    fn slug(self) -> &'static str {
        match self {
            AgentKind::Claude => "claude",
            AgentKind::Codex => "codex",
            AgentKind::Cursor => "cursor",
            AgentKind::Opencode => "opencode",
        }
    }

    fn label(self) -> &'static str {
        match self {
            AgentKind::Claude => "Claude",
            AgentKind::Codex => "Codex",
            AgentKind::Cursor => "Cursor",
            AgentKind::Opencode => "OpenCode",
        }
    }

    fn program(self) -> &'static str {
        match self {
            AgentKind::Claude => "claude",
            AgentKind::Codex => "codex",
            AgentKind::Cursor => "cursor-agent",
            AgentKind::Opencode => "opencode",
        }
    }
}

#[derive(Debug, Serialize)]
struct AgentHandoffResponse {
    agent: &'static str,
    handoff_id: String,
    prompt_path: String,
    context_path: String,
    script_path: String,
    status_path: String,
    log_path: String,
    command: String,
    message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AgentHandoffStatus {
    id: String,
    agent: String,
    state: AgentHandoffState,
    exit_code: Option<i32>,
    message: String,
    log_tail: Option<String>,
    prompt_path: String,
    context_path: String,
    script_path: String,
    log_path: String,
    updated_at: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum AgentHandoffState {
    Running,
    Succeeded,
    Failed,
}

struct AgentHandoffPaths<'a> {
    prompt_path: &'a Path,
    context_path: &'a Path,
    script_path: &'a Path,
    log_path: &'a Path,
}

impl AgentHandoffStatus {
    fn running(
        id: &str,
        agent: AgentKind,
        prompt_path: &Path,
        context_path: &Path,
        script_path: &Path,
        log_path: &Path,
    ) -> Self {
        Self {
            id: id.to_owned(),
            agent: agent.label().to_owned(),
            state: AgentHandoffState::Running,
            exit_code: None,
            message: format!(
                "{} is running. Prompt: {}",
                agent.label(),
                prompt_path.display()
            ),
            log_tail: None,
            prompt_path: prompt_path.to_string_lossy().to_string(),
            context_path: context_path.to_string_lossy().to_string(),
            script_path: script_path.to_string_lossy().to_string(),
            log_path: log_path.to_string_lossy().to_string(),
            updated_at: unix_timestamp(),
        }
    }

    fn failed(
        id: &str,
        agent: AgentKind,
        exit_code: Option<i32>,
        message: String,
        log_tail: Option<String>,
        paths: AgentHandoffPaths<'_>,
    ) -> Self {
        Self {
            id: id.to_owned(),
            agent: agent.label().to_owned(),
            state: AgentHandoffState::Failed,
            exit_code,
            message,
            log_tail,
            prompt_path: paths.prompt_path.to_string_lossy().to_string(),
            context_path: paths.context_path.to_string_lossy().to_string(),
            script_path: paths.script_path.to_string_lossy().to_string(),
            log_path: paths.log_path.to_string_lossy().to_string(),
            updated_at: unix_timestamp(),
        }
    }

    fn agent_kind(&self) -> Option<AgentKind> {
        match self.agent.as_str() {
            "Claude" => Some(AgentKind::Claude),
            "Codex" => Some(AgentKind::Codex),
            "Cursor" => Some(AgentKind::Cursor),
            "OpenCode" => Some(AgentKind::Opencode),
            _ => None,
        }
    }
}

#[derive(Debug, Serialize)]
struct AgentHandoffContext {
    report_path: String,
    artifact_path: String,
    workspace_root: Option<String>,
    symbol: SymbolReport,
    callers: Vec<AgentGraphEdgeContext>,
    callees: Vec<AgentGraphEdgeContext>,
    worst_path: Vec<SymbolReport>,
    source: Option<SourceSnippet>,
    disassembly: Option<DisassemblyView>,
}

#[derive(Debug, Serialize)]
struct AgentGraphEdgeContext {
    edge: EdgeReport,
    symbol: Option<SymbolReport>,
}

#[derive(Debug, Serialize)]
struct SymbolContext {
    source: Option<SourceSnippet>,
    disassembly: Option<DisassemblyView>,
    messages: Vec<String>,
}

#[derive(Debug, Serialize)]
struct SourceFileContext {
    source: Option<SourceSnippet>,
    messages: Vec<String>,
}

#[derive(Debug, Serialize)]
struct SourceSnippet {
    file: String,
    line: Option<u32>,
    start_line: u32,
    language: String,
    lines: Vec<SourceLine>,
}

#[derive(Debug, Serialize)]
struct SourceLine {
    number: u32,
    text: String,
    highlight: bool,
}

#[derive(Debug, Serialize)]
struct DisassemblyView {
    architecture: String,
    syntax: String,
    instructions: Vec<InstructionLine>,
}

#[derive(Debug, Serialize)]
struct InstructionLine {
    address: String,
    bytes: String,
    text: String,
}

fn content_type(value: &str) -> Header {
    Header::from_bytes("content-type", value).expect("static header is valid")
}

static UI_ASSETS: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/assets/app");

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    use super::windows_agent_shell_args;
    use super::{
        agent_handoff_status_path, enrich_agent_status, friendly_agent_failure_message,
        resolve_rust_std_source_path_with_roots, rust_library_relative_path,
        sanitize_file_component, ui_asset_path, write_agent_script, AgentHandoffPaths,
        AgentHandoffRequest, AgentHandoffState, AgentHandoffStatus, AgentKind, AgentScriptConfig,
    };
    use std::fs;
    use std::path::PathBuf;
    #[cfg(windows)]
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    use stackwise_core::{
        ArtifactInfo, BuildInfo, Confidence, ExactMode, GeneratorInfo, ObjectFormat,
        StackwiseReport, Summary,
    };

    #[test]
    fn detects_mixed_separator_rustc_library_paths() {
        let relative =
            rust_library_relative_path("/rustc/abc123/library\\std\\src\\sys\\backtrace.rs")
                .expect("rustc remapped path should be detected");

        assert_eq!(
            relative,
            PathBuf::from("std")
                .join("src")
                .join("sys")
                .join("backtrace.rs")
        );
    }

    #[test]
    fn rejects_rustc_library_path_traversal() {
        assert!(rust_library_relative_path("/rustc/abc123/library/../secret.rs").is_none());
    }

    #[test]
    fn ignores_non_rustc_library_paths() {
        assert!(rust_library_relative_path("vendor/library/std/src/rt.rs").is_none());
    }

    #[test]
    fn resolves_rustc_library_paths_to_local_rust_src() {
        let root = unique_temp_dir();
        let source = root.join("std").join("src").join("rt.rs");
        fs::create_dir_all(source.parent().expect("source has parent"))
            .expect("test source parent is created");
        fs::write(&source, "fn handle_rt_panic() {}\n").expect("test source is written");

        let resolved = resolve_rust_std_source_path_with_roots(
            "/rustc/abc123/library\\std\\src\\rt.rs",
            [root.clone()],
        )
        .expect("rust-src path should resolve");

        assert_eq!(resolved, source);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn maps_ui_asset_paths_without_traversal() {
        assert_eq!(ui_asset_path("/"), Some("index.html".to_owned()));
        assert_eq!(
            ui_asset_path("/assets/index.js?cache=1"),
            Some("assets/index.js".to_owned())
        );
        assert!(ui_asset_path("/assets/../secret").is_none());
    }

    #[test]
    fn sanitizes_agent_handoff_file_names() {
        assert_eq!(
            sanitize_file_component("crate::module::<T as Trait>::function"),
            "crate-module-t-as-trait-function"
        );
        assert_eq!(sanitize_file_component("!!!"), "symbol");
    }

    #[test]
    fn decodes_agent_handoff_requests() {
        let request: AgentHandoffRequest =
            serde_json::from_str(r#"{"agent":"codex","symbol_id":42}"#)
                .expect("request is decoded");

        assert_eq!(request.agent.slug(), "codex");
        assert_eq!(
            request.agent.command_preview("Read the Stackwise brief."),
            "codex exec \"Read the Stackwise brief.\""
        );
        assert_eq!(request.symbol_id, 42);

        let request: AgentHandoffRequest =
            serde_json::from_str(r#"{"agent":"opencode","symbol_id":7}"#)
                .expect("opencode request is decoded");

        assert_eq!(request.agent.slug(), "opencode");
        assert_eq!(request.agent.program(), "opencode");
        assert_eq!(
            request.agent.command_preview("Read the Stackwise brief."),
            "opencode run \"Read the Stackwise brief.\""
        );
        assert_eq!(request.symbol_id, 7);
    }

    #[test]
    fn classifies_claude_org_access_failures() {
        let message = friendly_agent_failure_message(
            Some(AgentKind::Claude),
            "Your organization does not have access to Claude. Please login again or contact your administrator.",
            Some(1),
        )
        .expect("Claude access failure should be classified");

        assert!(message.contains("Claude is unavailable"));
        assert!(message.contains("Codex"));
        assert!(message.contains("OpenCode"));
    }

    #[test]
    fn enriches_failed_agent_status_from_log_tail() {
        let prompt_path = PathBuf::from("prompt.md");
        let context_path = PathBuf::from("context.json");
        let script_path = PathBuf::from("launch.cmd");
        let log_path = PathBuf::from("launch.log");
        let status = AgentHandoffStatus::failed(
            "123-claude-demo",
            AgentKind::Claude,
            Some(1),
            "Claude exited with code 1.".to_owned(),
            Some("Your organization does not have access to Claude.".to_owned()),
            AgentHandoffPaths {
                prompt_path: &prompt_path,
                context_path: &context_path,
                script_path: &script_path,
                log_path: &log_path,
            },
        );

        let status = enrich_agent_status(status);

        assert_eq!(status.state, AgentHandoffState::Failed);
        assert!(status.message.contains("Claude is unavailable"));
    }

    #[test]
    fn validates_handoff_status_paths() {
        let report_path = camino::Utf8PathBuf::from("target/report.json");

        assert!(agent_handoff_status_path(&report_path, "123-claude-symbol").is_some());
        assert!(agent_handoff_status_path(&report_path, "../secret").is_none());
        assert!(agent_handoff_status_path(&report_path, "").is_none());
    }

    #[cfg(windows)]
    #[test]
    fn windows_agent_script_writes_status_and_log_paths() {
        let root = unique_temp_dir();
        let script_path = root.join("launch.cmd");
        let prompt_path = root.join("brief.prompt.md");
        let context_path = root.join("brief.context.json");
        let status_path = root.join("brief.status.json");
        let log_path = root.join("brief.log");

        fs::create_dir_all(&root).expect("temp root is created");
        let report = minimal_report(root.to_string_lossy().as_ref());
        write_agent_script(AgentScriptConfig {
            script_path: &script_path,
            agent: AgentKind::Claude,
            handoff_id: "123-claude-demo",
            prompt_path: &prompt_path,
            context_path: &context_path,
            status_path: &status_path,
            log_path: &log_path,
            report: &report,
        })
        .expect("script should be written");

        let script = fs::read_to_string(&script_path).expect("script is readable");
        assert!(script.contains("STACKWISE_STATUS_FILE"));
        assert!(script.contains("STACKWISE_LOG_FILE"));
        assert!(script.contains("powershell -NoProfile"));
        assert!(script.contains("does not have access to Claude"));

        let _ = fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn windows_codex_script_uses_exec_prompt_argument() {
        let root = unique_temp_dir();
        let script_path = root.join("launch.cmd");
        let prompt_path = root.join("brief.prompt.md");
        let context_path = root.join("brief.context.json");
        let status_path = root.join("brief.status.json");
        let log_path = root.join("brief.log");

        fs::create_dir_all(&root).expect("temp root is created");
        let report = minimal_report(root.to_string_lossy().as_ref());
        write_agent_script(AgentScriptConfig {
            script_path: &script_path,
            agent: AgentKind::Codex,
            handoff_id: "123-codex-demo",
            prompt_path: &prompt_path,
            context_path: &context_path,
            status_path: &status_path,
            log_path: &log_path,
            report: &report,
        })
        .expect("script should be written");

        let script = fs::read_to_string(&script_path).expect("script is readable");
        assert!(script.contains("call codex exec \"%STACKWISE_PROMPT%\""));
        assert!(!script.contains("call codex -p"));

        let _ = fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn windows_agent_script_records_nonzero_exit_status() {
        let root = unique_temp_dir();
        let bin = root.join("bin");
        let script_path = root.join("launch.cmd");
        let prompt_path = root.join("brief.prompt.md");
        let context_path = root.join("brief.context.json");
        let status_path = root.join("brief.status.json");
        let log_path = root.join("brief.log");

        fs::create_dir_all(&bin).expect("test bin is created");
        fs::write(
            bin.join("cursor-agent.cmd"),
            "@echo fake cursor failure\r\n@exit /b 7\r\n",
        )
        .expect("fake agent is written");
        fs::write(&prompt_path, "optimize this").expect("prompt is written");

        let report = minimal_report(root.to_string_lossy().as_ref());
        write_agent_script(AgentScriptConfig {
            script_path: &script_path,
            agent: AgentKind::Cursor,
            handoff_id: "123-cursor-demo",
            prompt_path: &prompt_path,
            context_path: &context_path,
            status_path: &status_path,
            log_path: &log_path,
            report: &report,
        })
        .expect("script should be written");

        let path = format!(
            "{};{}",
            bin.to_string_lossy(),
            std::env::var("PATH").unwrap_or_default()
        );
        let output = Command::new("cmd")
            .arg("/C")
            .arg(&script_path)
            .env("PATH", path)
            .output()
            .expect("handoff script should run");

        assert!(output.status.success());
        let status: AgentHandoffStatus =
            serde_json::from_slice(&fs::read(&status_path).expect("status should be written"))
                .expect("status should be valid JSON");
        assert_eq!(status.state, AgentHandoffState::Failed);
        assert_eq!(status.exit_code, Some(7));
        assert!(status
            .log_tail
            .as_deref()
            .unwrap_or_default()
            .contains("fake cursor failure"));

        let _ = fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn windows_agent_shell_args_use_empty_start_title() {
        let script = PathBuf::from(r"D:\repo\target\stackwise\handoff.cmd");
        let args = windows_agent_shell_args(&script);

        assert_eq!(args[0], "/C");
        assert_eq!(args[1], "start");
        assert_eq!(args[2], "");
        assert_eq!(args[3], "cmd");
        assert_eq!(args[4], "/C");
        assert_eq!(args[5], script.as_os_str());
    }

    fn unique_temp_dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock is after unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("stackwise-rust-src-test-{nanos}"))
    }

    fn minimal_report(workspace_root: &str) -> StackwiseReport {
        StackwiseReport {
            schema_version: "0.1.0".to_owned(),
            generator: GeneratorInfo {
                name: "stackwise".to_owned(),
                version: "0.1.0".to_owned(),
            },
            artifact: ArtifactInfo {
                path: "demo.exe".to_owned(),
                file_name: "demo.exe".to_owned(),
                format: ObjectFormat::PeCoff,
                architecture: "x86_64".to_owned(),
                pointer_width: Some(64),
                size_bytes: 1,
            },
            build: Some(BuildInfo {
                workspace_root: Some(workspace_root.to_owned()),
                package: Some("demo".to_owned()),
                profile: Some("release".to_owned()),
                target: None,
                features: Vec::new(),
                exact_mode: ExactMode::Auto,
            }),
            summary: Summary {
                symbol_count: 0,
                edge_count: 0,
                known_frame_count: 0,
                unknown_frame_count: 0,
                recursive_symbol_count: 0,
                indirect_edge_count: 0,
                max_own_frame: None,
                max_worst_path: None,
                confidence: Confidence::Unknown,
            },
            symbols: Vec::new(),
            edges: Vec::new(),
            groups: Vec::new(),
            diagnostics: Vec::new(),
        }
    }
}
