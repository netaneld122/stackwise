pub fn demangle(name: &str) -> String {
    rustc_demangle::try_demangle(name)
        .map(|demangled| format!("{demangled:#}"))
        .unwrap_or_else(|_| name.to_owned())
}

pub fn crate_and_module(demangled: &str) -> (Option<String>, Vec<String>) {
    let cleaned = strip_hash_suffix(demangled);
    if let Some(parsed) = impl_crate_and_module(cleaned) {
        return parsed;
    }

    path_crate_and_module(cleaned).unwrap_or((None, Vec::new()))
}

fn impl_crate_and_module(name: &str) -> Option<(Option<String>, Vec<String>)> {
    let impl_head = leading_impl_head(name)?;
    let (subject, trait_path) = split_impl_subject_and_trait(impl_head);

    path_crate_and_module(strip_type_prefixes(subject))
        .or_else(|| trait_path.and_then(path_crate_and_module))
}

fn path_crate_and_module(path: &str) -> Option<(Option<String>, Vec<String>)> {
    let parts = split_rust_path(path);
    if parts.is_empty() {
        return None;
    }

    let segments = parts
        .iter()
        .filter_map(|part| sanitize_segment(part))
        .collect::<Vec<_>>();
    let crate_name = segments.first().filter(|part| is_crate_like(part)).cloned();
    let crate_name = crate_name?;

    let module_path = if segments.len() > 1 {
        segments[..segments.len() - 1].to_vec()
    } else {
        vec![crate_name.clone()]
    };

    Some((Some(crate_name), module_path))
}

fn leading_impl_head(name: &str) -> Option<&str> {
    if !name.starts_with('<') {
        return None;
    }

    let mut depth = 0i32;
    for (index, ch) in name.char_indices() {
        match ch {
            '<' => depth += 1,
            '>' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&name[1..index]);
                }
            }
            _ => {}
        }
    }

    None
}

fn split_impl_subject_and_trait(impl_head: &str) -> (&str, Option<&str>) {
    let mut depth = 0i32;
    for (index, ch) in impl_head.char_indices() {
        if depth == 0 && impl_head[index..].starts_with(" as ") {
            return (&impl_head[..index], Some(&impl_head[index + 4..]));
        }

        match ch {
            '<' | '(' | '[' => depth += 1,
            '>' | ')' | ']' => depth -= 1,
            _ => {}
        }
    }

    (impl_head, None)
}

fn strip_type_prefixes(mut path: &str) -> &str {
    loop {
        let trimmed = path.trim();
        if let Some(rest) = trimmed.strip_prefix('&') {
            path = rest;
        } else if let Some(rest) = trimmed.strip_prefix("*const ") {
            path = rest;
        } else if let Some(rest) = trimmed.strip_prefix("*mut ") {
            path = rest;
        } else if let Some(rest) = trimmed.strip_prefix("mut ") {
            path = rest;
        } else if let Some(rest) = trimmed.strip_prefix("const ") {
            path = rest;
        } else if let Some(rest) = trimmed.strip_prefix("dyn ") {
            path = rest;
        } else {
            return trimmed;
        }
    }
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

fn sanitize_segment(segment: &str) -> Option<String> {
    let sanitized = segment
        .split_once('<')
        .map(|(head, _)| head)
        .unwrap_or(segment)
        .trim()
        .to_owned();
    (!sanitized.is_empty()).then_some(sanitized)
}

fn is_crate_like(segment: &str) -> bool {
    !segment.starts_with('{') && !segment.starts_with('[') && !is_primitive_type(segment)
}

fn is_primitive_type(segment: &str) -> bool {
    matches!(
        segment,
        "bool"
            | "char"
            | "str"
            | "i8"
            | "i16"
            | "i32"
            | "i64"
            | "i128"
            | "isize"
            | "u8"
            | "u16"
            | "u32"
            | "u64"
            | "u128"
            | "usize"
            | "f32"
            | "f64"
    )
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

    #[test]
    fn extracts_module_from_trait_impl_subject() {
        let (krate, module) =
            crate_and_module("<rustc_demangle::legacy::Demangle as core::fmt::Display>::fmt");

        assert_eq!(krate.as_deref(), Some("rustc_demangle"));
        assert_eq!(module, ["rustc_demangle", "legacy"]);
    }

    #[test]
    fn extracts_module_from_generic_trait_impl_subject() {
        let (krate, module) = crate_and_module(
            "<rustc_demangle::SizeLimitedFmtAdapter<&mut core::fmt::Formatter> as core::fmt::Write>::write_str",
        );

        assert_eq!(krate.as_deref(), Some("rustc_demangle"));
        assert_eq!(module, ["rustc_demangle"]);
    }

    #[test]
    fn falls_back_to_trait_for_primitive_impl_subject() {
        let (krate, module) = crate_and_module("<&str as core::fmt::Debug>::fmt");

        assert_eq!(krate.as_deref(), Some("core"));
        assert_eq!(module, ["core", "fmt"]);
    }
}
