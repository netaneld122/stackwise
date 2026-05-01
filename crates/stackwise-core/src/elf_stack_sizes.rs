use std::collections::BTreeMap;

use object::{Object, ObjectSection};

pub fn parse_elf_stack_sizes<'data>(
    file: &object::File<'data>,
) -> Result<BTreeMap<u64, u64>, StackSizeParseError> {
    let Some(section) = file.section_by_name(".stack_sizes") else {
        return Ok(BTreeMap::new());
    };

    let data = section
        .data()
        .map_err(|source| StackSizeParseError::SectionData(source.to_string()))?;
    let pointer_width = if file.is_64() { 8 } else { 4 };
    let little = file.is_little_endian();
    parse_entries(data, pointer_width, little)
}

pub fn parse_entries(
    data: &[u8],
    pointer_width: usize,
    little_endian: bool,
) -> Result<BTreeMap<u64, u64>, StackSizeParseError> {
    let mut offset = 0;
    let mut entries = BTreeMap::new();

    while offset < data.len() {
        if data.len() - offset < pointer_width {
            return Err(StackSizeParseError::TruncatedAddress { offset });
        }

        let address = read_address(&data[offset..offset + pointer_width], little_endian);
        offset += pointer_width;

        let (size, used) =
            read_uleb128(&data[offset..]).ok_or(StackSizeParseError::TruncatedUleb { offset })?;
        offset += used;

        entries.insert(address, size);
    }

    Ok(entries)
}

fn read_address(bytes: &[u8], little_endian: bool) -> u64 {
    let mut value = 0u64;
    if little_endian {
        for (shift, byte) in bytes.iter().enumerate() {
            value |= u64::from(*byte) << (shift * 8);
        }
    } else {
        for byte in bytes {
            value = (value << 8) | u64::from(*byte);
        }
    }
    value
}

fn read_uleb128(bytes: &[u8]) -> Option<(u64, usize)> {
    let mut value = 0u64;
    let mut shift = 0u32;

    for (index, byte) in bytes.iter().copied().enumerate() {
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Some((value, index + 1));
        }
        shift += 7;
        if shift >= 64 {
            return None;
        }
    }

    None
}

#[derive(Debug, thiserror::Error)]
pub enum StackSizeParseError {
    #[error("failed to read .stack_sizes section: {0}")]
    SectionData(String),
    #[error(".stack_sizes entry at offset {offset} has a truncated address")]
    TruncatedAddress { offset: usize },
    #[error(".stack_sizes entry at offset {offset} has a truncated ULEB128 size")]
    TruncatedUleb { offset: usize },
}

#[cfg(test)]
mod tests {
    use super::parse_entries;

    #[test]
    fn parses_little_endian_stack_size_entries() {
        let data = [
            0x10, 0x20, 0x00, 0x00, 0x08, 0x20, 0x20, 0x00, 0x00, 0x80, 0x01,
        ];
        let parsed = parse_entries(&data, 4, true).unwrap();

        assert_eq!(parsed.get(&0x2010), Some(&8));
        assert_eq!(parsed.get(&0x2020), Some(&128));
    }
}
