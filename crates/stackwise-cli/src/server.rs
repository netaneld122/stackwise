use std::fs;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::thread;

use anyhow::Context;
use camino::Utf8PathBuf;
use iced_x86::{Decoder, DecoderOptions, Formatter, NasmFormatter};
use object::{Object, ObjectSection};
use serde::Serialize;
use stackwise_core::{SourceLocation, StackwiseReport, SymbolReport};
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
            (Method::Get, "/") | (Method::Get, "/index.html") => html_response(INDEX_HTML),
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
            (Method::Post, "/api/open-source") => {
                let mut body = String::new();
                let _ = request.as_reader().read_to_string(&mut body);
                text_response(
                    StatusCode(501),
                    "editor integration is not enabled in this build".to_owned(),
                )
            }
            _ => text_response(StatusCode(404), "not found".to_owned()),
        };

        let _ = request.respond(response);
        thread::yield_now();
    }

    Ok(())
}

fn html_response(text: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_string(text.to_owned()).with_header(content_type("text/html; charset=utf-8"))
}

fn json_response(data: Vec<u8>) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_data(data).with_header(content_type("application/json"))
}

fn text_response(status: StatusCode, text: String) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_string(text)
        .with_status_code(status)
        .with_header(content_type("text/plain; charset=utf-8"))
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
        messages.push("No source location was available for this symbol.".to_owned());
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

fn source_snippet(symbol: &SymbolReport, report: &StackwiseReport) -> Option<SourceSnippet> {
    let location = symbol.source_location.as_ref()?;
    let path = resolve_source_path(location, report)?;
    let text = fs::read_to_string(&path).ok()?;
    let lines = text.lines().collect::<Vec<_>>();
    if lines.is_empty() {
        return None;
    }

    let highlight_line = location.line.unwrap_or(1).clamp(1, lines.len() as u32);
    let (start, end) = function_span(&lines, highlight_line as usize - 1);

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

fn resolve_source_path(location: &SourceLocation, report: &StackwiseReport) -> Option<PathBuf> {
    let raw = PathBuf::from(&location.file);
    if raw.is_file() {
        return Some(raw);
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

#[derive(Debug, Serialize)]
struct SymbolContext {
    source: Option<SourceSnippet>,
    disassembly: Option<DisassemblyView>,
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

const INDEX_HTML: &str = include_str!("../assets/index.html");
