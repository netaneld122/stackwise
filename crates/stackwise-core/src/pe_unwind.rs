use object::{Object, ObjectSection};

#[derive(Debug, Clone, Copy)]
pub struct PeUnwindRecord {
    pub begin: u64,
    pub end: u64,
    pub stack_bytes: u64,
}

pub fn parse_pe_x64_unwind<'data>(file: &object::File<'data>) -> Vec<PeUnwindRecord> {
    let Some(pdata) = file.sections().find(|section| {
        section
            .name()
            .map(|name| name.trim_end_matches('\0') == ".pdata")
            .unwrap_or(false)
    }) else {
        return Vec::new();
    };

    let Ok(pdata_bytes) = pdata.data() else {
        return Vec::new();
    };

    let image_base = file.relative_address_base();
    let sections = file
        .sections()
        .filter_map(|section| {
            let data = section.data().ok()?;
            Some(SectionRange {
                address: section.address(),
                data,
            })
        })
        .collect::<Vec<_>>();
    let mut frames = Vec::new();

    for chunk in pdata_bytes.chunks_exact(12) {
        let begin = image_base + read_u32(chunk, 0);
        let end = image_base + read_u32(chunk, 4);
        let unwind_rva = image_base + read_u32(chunk, 8);

        if let Some(unwind_bytes) = section_tail(unwind_rva, &sections) {
            let Some(bytes) = parse_unwind_info(unwind_bytes) else {
                continue;
            };
            frames.push(PeUnwindRecord {
                begin,
                end,
                stack_bytes: bytes,
            });
        }
    }

    frames
}

pub fn infer_pe_image_base<'data>(file: &object::File<'data>) -> Option<u64> {
    Some(file.relative_address_base())
}

fn section_tail<'a>(rva: u64, sections: &'a [SectionRange<'a>]) -> Option<&'a [u8]> {
    sections.iter().find_map(|section| {
        let offset = rva.checked_sub(section.address)? as usize;
        section.data.get(offset..)
    })
}

struct SectionRange<'a> {
    address: u64,
    data: &'a [u8],
}

fn parse_unwind_info(bytes: &[u8]) -> Option<u64> {
    if bytes.len() < 4 {
        return None;
    }

    let count = usize::from(bytes[2]);
    let codes_len = count.checked_mul(2)?;
    if bytes.len() < 4 + codes_len {
        return None;
    }

    let mut stack = 0u64;
    let mut index = 0usize;
    let codes = &bytes[4..4 + codes_len];

    while index < count {
        let slot = index * 2;
        let op_and_info = codes[slot + 1];
        let op = op_and_info & 0x0f;
        let info = op_and_info >> 4;

        match op {
            0 => stack += 8,
            1 if info == 0 => {
                let value = read_code_u16(codes, index + 1)?;
                stack += u64::from(value) * 8;
                index += 1;
            }
            1 => {
                let low = u32::from(read_code_u16(codes, index + 1)?);
                let high = u32::from(read_code_u16(codes, index + 2)?);
                stack += u64::from((high << 16) | low);
                index += 2;
            }
            2 => stack += u64::from(info) * 8 + 8,
            3 => {}
            4 | 8 => index += 1,
            5 | 9 => index += 2,
            10 => stack += if info == 0 { 40 } else { 48 },
            _ => {}
        }

        index += 1;
    }

    Some(stack)
}

fn read_code_u16(codes: &[u8], index: usize) -> Option<u16> {
    let offset = index.checked_mul(2)?;
    let bytes = codes.get(offset..offset + 2)?;
    Some(u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn read_u32(bytes: &[u8], offset: usize) -> u64 {
    u64::from(u32::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ]))
}

#[cfg(test)]
mod tests {
    use super::parse_unwind_info;

    #[test]
    fn parses_small_alloc_and_push() {
        let bytes = [0x01, 0x04, 0x02, 0x00, 0x01, 0x50, 0x02, 0x32];
        assert_eq!(parse_unwind_info(&bytes), Some(40));
    }
}
