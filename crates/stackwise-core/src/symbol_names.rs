pub fn demangle(name: &str) -> String {
    rustc_demangle::try_demangle(name)
        .map(|demangled| format!("{demangled:#}"))
        .unwrap_or_else(|_| name.to_owned())
}

pub fn crate_and_module(demangled: &str) -> (Option<String>, Vec<String>) {
    let cleaned = strip_hash_suffix(demangled);
    let parts = split_rust_path(cleaned);

    if parts.is_empty() {
        return (None, Vec::new());
    }

    let crate_name = parts
        .first()
        .filter(|part| !part.starts_with('<') && !part.starts_with('{'))
        .map(|part| sanitize_segment(part));

    let module_path = if parts.len() > 1 {
        parts[..parts.len() - 1]
            .iter()
            .map(|part| sanitize_segment(part))
            .collect()
    } else {
        crate_name.iter().cloned().collect()
    };

    (crate_name, module_path)
}

fn strip_hash_suffix(name: &str) -> &str {
    let Some((before, after)) = name.rsplit_once("::h") else {
        return name;
    };

    if after.chars().all(|ch| ch.is_ascii_hexdigit()) {
        before
    } else {
        name
    }
}

fn split_rust_path(name: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut depth = 0i32;
    let mut start = 0usize;
    let bytes = name.as_bytes();
    let mut index = 0usize;

    while index + 1 < bytes.len() {
        match bytes[index] {
            b'<' | b'(' | b'[' => depth += 1,
            b'>' | b')' | b']' => depth -= 1,
            b':' if depth == 0 && bytes[index + 1] == b':' => {
                parts.push(name[start..index].trim());
                index += 1;
                start = index + 1;
            }
            _ => {}
        }
        index += 1;
    }

    let tail = name[start..].trim();
    if !tail.is_empty() {
        parts.push(tail);
    }

    parts
}

fn sanitize_segment(segment: &str) -> String {
    segment
        .split_once('<')
        .map(|(head, _)| head)
        .unwrap_or(segment)
        .trim()
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::crate_and_module;

    #[test]
    fn extracts_crate_and_module_from_rust_path() {
        let (krate, module) = crate_and_module("demo::inner::work");
        assert_eq!(krate.as_deref(), Some("demo"));
        assert_eq!(module, ["demo", "inner"]);
    }
}
