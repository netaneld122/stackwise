use std::fs;
use std::net::TcpListener;
use std::thread;

use anyhow::Context;
use camino::Utf8PathBuf;
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

fn content_type(value: &str) -> Header {
    Header::from_bytes("content-type", value).expect("static header is valid")
}

const INDEX_HTML: &str = include_str!("../assets/index.html");
