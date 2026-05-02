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

    let base_name = format!(
        "{}-{}-{}",
        unix_timestamp(),
        request.agent.slug(),
        sanitize_file_component(&symbol.demangled)
    );
    let context_path = handoff_dir.join(format!("{base_name}.context.json"));
    let prompt_path = handoff_dir.join(format!("{base_name}.prompt.md"));
    let script_path = handoff_dir.join(format!("{base_name}{}", shell_script_extension()));
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
    if let Err(error) = write_agent_script(&script_path, request.agent, &prompt_path, &report) {
        return text_response(
            StatusCode(500),
            format!("failed to write agent launch script: {error}"),
        );
    }
    if let Err(error) = launch_agent_shell(&script_path, request.agent) {
        return text_response(
            StatusCode(500),
            format!("failed to launch {}: {error}", request.agent.label()),
        );
    }

    json_value_response(&AgentHandoffResponse {
        agent: request.agent.label(),
        prompt_path: prompt_path.to_string_lossy().to_string(),
        context_path: context_path.to_string_lossy().to_string(),
        script_path: script_path.to_string_lossy().to_string(),
        command: format!(
            "{} -p \"Read the Stackwise optimization brief at {} and follow it.\"",
            request.agent.program(),
            prompt_path.display()
        ),
        message: format!(
            "Started {} with a Stackwise stack-optimization brief.",
            request.agent.label()
        ),
    })
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

fn agent_handoff_dir(report_path: &Utf8PathBuf) -> PathBuf {
    report_path
        .as_std_path()
        .parent()
        .map(|parent| parent.join("stackwise-agent-handoffs"))
        .unwrap_or_else(|| PathBuf::from("stackwise-agent-handoffs"))
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

fn write_agent_script(
    script_path: &Path,
    agent: AgentKind,
    prompt_path: &Path,
    report: &StackwiseReport,
) -> anyhow::Result<()> {
    let prompt = format!(
        "Read the Stackwise optimization brief at {} and follow it.",
        prompt_path.display()
    );
    let cwd = report
        .build
        .as_ref()
        .and_then(|build| build.workspace_root.as_deref())
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."));

    #[cfg(windows)]
    {
        let script = format!(
            "@echo off\r\ncd /d \"{}\"\r\nset \"STACKWISE_PROMPT={}\"\r\nset \"STACKWISE_PROMPT_FILE={}\"\r\necho Stackwise launching {} for stack optimization...\r\necho Prompt: \"%STACKWISE_PROMPT_FILE%\"\r\n{} -p \"%STACKWISE_PROMPT%\"\r\necho.\r\necho Agent exited with %ERRORLEVEL%.\r\n",
            escape_batch_quoted(&cwd.to_string_lossy()),
            escape_batch_env(&prompt),
            escape_batch_env(&prompt_path.to_string_lossy()),
            agent.label(),
            agent.program()
        );
        fs::write(script_path, script)?;
    }
    #[cfg(not(windows))]
    {
        let script = format!(
            "#!/usr/bin/env sh\ncd {}\nprintf '%s\\n' {}\n{} -p {}\n",
            shell_quote(&cwd.to_string_lossy()),
            shell_quote(&format!(
                "Stackwise launching {} for stack optimization...",
                agent.label()
            )),
            shell_quote(agent.program()),
            shell_quote(&prompt)
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
            .args(["/C", "start", agent.label(), "cmd", "/K"])
            .arg(script_path)
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

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum AgentKind {
    Claude,
    Codex,
    Cursor,
}

impl AgentKind {
    fn slug(self) -> &'static str {
        match self {
            AgentKind::Claude => "claude",
            AgentKind::Codex => "codex",
            AgentKind::Cursor => "cursor",
        }
    }

    fn label(self) -> &'static str {
        match self {
            AgentKind::Claude => "Claude",
            AgentKind::Codex => "Codex",
            AgentKind::Cursor => "Cursor",
        }
    }

    fn program(self) -> &'static str {
        match self {
            AgentKind::Claude => "claude",
            AgentKind::Codex => "codex",
            AgentKind::Cursor => "cursor-agent",
        }
    }
}

#[derive(Debug, Serialize)]
struct AgentHandoffResponse {
    agent: &'static str,
    prompt_path: String,
    context_path: String,
    script_path: String,
    command: String,
    message: String,
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
    use super::{
        resolve_rust_std_source_path_with_roots, rust_library_relative_path,
        sanitize_file_component, ui_asset_path, AgentHandoffRequest,
    };
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

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
        assert_eq!(request.symbol_id, 42);
    }

    fn unique_temp_dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock is after unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("stackwise-rust-src-test-{nanos}"))
    }
}
