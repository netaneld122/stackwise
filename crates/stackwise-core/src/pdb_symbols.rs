use std::collections::BTreeMap;
use std::fs::File;

use camino::{Utf8Path, Utf8PathBuf};
use pdb::{FallibleIterator, SymbolData, PDB};

use crate::pe_unwind;
use crate::SourceLocation;

#[derive(Debug, Clone)]
pub struct PdbSymbol {
    pub name: String,
    pub address: u64,
    pub size: u64,
    pub source_location: Option<SourceLocation>,
}

pub fn load_pdb_symbols(
    artifact_path: &Utf8Path,
    file: &object::File<'_>,
) -> Result<Option<Vec<PdbSymbol>>, PdbSymbolError> {
    let Some(image_base) = pe_unwind::infer_pe_image_base(file) else {
        return Ok(None);
    };
    let Some(pdb_path) = find_adjacent_pdb(artifact_path) else {
        return Ok(None);
    };

    let pdb_file = File::open(pdb_path.as_std_path()).map_err(|source| PdbSymbolError::Open {
        path: pdb_path.clone(),
        source,
    })?;
    let mut pdb = PDB::open(pdb_file).map_err(|source| PdbSymbolError::Parse {
        path: pdb_path.clone(),
        message: source.to_string(),
    })?;
    let address_map = pdb.address_map().map_err(|source| PdbSymbolError::Parse {
        path: pdb_path.clone(),
        message: source.to_string(),
    })?;
    let string_table = pdb.string_table().ok();

    let mut symbols = BTreeMap::<u64, PdbSymbol>::new();
    collect_global_symbols(&mut pdb, image_base, &address_map, &mut symbols)?;
    collect_module_symbols(
        &mut pdb,
        image_base,
        &address_map,
        string_table.as_ref(),
        &mut symbols,
    )?;

    Ok(Some(symbols.into_values().collect()))
}

fn collect_global_symbols<'s, S: pdb::Source<'s> + 's>(
    pdb: &mut PDB<'s, S>,
    image_base: u64,
    address_map: &pdb::AddressMap<'_>,
    symbols: &mut BTreeMap<u64, PdbSymbol>,
) -> Result<(), PdbSymbolError> {
    let symbol_table = pdb
        .global_symbols()
        .map_err(|source| PdbSymbolError::ReadSymbols(source.to_string()))?;
    let mut iter = symbol_table.iter();

    while let Some(symbol) = iter
        .next()
        .map_err(|source| PdbSymbolError::ReadSymbols(source.to_string()))?
    {
        let Ok(SymbolData::Public(public)) = symbol.parse() else {
            continue;
        };
        if !public.function {
            continue;
        }
        let Some(rva) = public.offset.to_rva(address_map) else {
            continue;
        };
        let address = image_base + u64::from(rva.0);
        symbols.entry(address).or_insert_with(|| PdbSymbol {
            name: public.name.to_string().into_owned(),
            address,
            size: 0,
            source_location: None,
        });
    }

    Ok(())
}

fn collect_module_symbols<'s, S: pdb::Source<'s> + 's>(
    pdb: &mut PDB<'s, S>,
    image_base: u64,
    address_map: &pdb::AddressMap<'_>,
    string_table: Option<&pdb::StringTable<'_>>,
    symbols: &mut BTreeMap<u64, PdbSymbol>,
) -> Result<(), PdbSymbolError> {
    let dbi = pdb
        .debug_information()
        .map_err(|source| PdbSymbolError::ReadSymbols(source.to_string()))?;
    let mut modules = dbi
        .modules()
        .map_err(|source| PdbSymbolError::ReadSymbols(source.to_string()))?;

    while let Some(module) = modules
        .next()
        .map_err(|source| PdbSymbolError::ReadSymbols(source.to_string()))?
    {
        let Some(info) = pdb
            .module_info(&module)
            .map_err(|source| PdbSymbolError::ReadSymbols(source.to_string()))?
        else {
            continue;
        };
        let line_program = info.line_program().ok();
        let mut iter = info
            .symbols()
            .map_err(|source| PdbSymbolError::ReadSymbols(source.to_string()))?;

        while let Some(symbol) = iter
            .next()
            .map_err(|source| PdbSymbolError::ReadSymbols(source.to_string()))?
        {
            let Ok(SymbolData::Procedure(procedure)) = symbol.parse() else {
                continue;
            };
            let Some(rva) = procedure.offset.to_rva(address_map) else {
                continue;
            };
            let address = image_base + u64::from(rva.0);
            symbols.insert(
                address,
                PdbSymbol {
                    name: procedure.name.to_string().into_owned(),
                    address,
                    size: u64::from(procedure.len),
                    source_location: source_location_for_procedure(
                        line_program.as_ref(),
                        string_table,
                        address_map,
                        procedure.offset,
                    ),
                },
            );
        }
    }

    Ok(())
}

fn source_location_for_procedure(
    line_program: Option<&pdb::LineProgram<'_>>,
    string_table: Option<&pdb::StringTable<'_>>,
    address_map: &pdb::AddressMap<'_>,
    offset: pdb::PdbInternalSectionOffset,
) -> Option<SourceLocation> {
    let line_program = line_program?;
    let string_table = string_table?;
    let mut lines = line_program.lines_for_symbol(offset);
    let mut best = None;

    while let Some(line) = lines.next().ok()? {
        let rva = line.offset.to_rva(address_map)?;
        let file_info = line_program.get_file_info(line.file_index).ok()?;
        let file = file_info
            .name
            .to_string_lossy(string_table)
            .ok()?
            .into_owned();
        let candidate = (rva.0, file, line.line_start, line.column_start);
        if best
            .as_ref()
            .is_none_or(|(best_rva, _, _, _)| candidate.0 < *best_rva)
        {
            best = Some(candidate);
        }
    }

    best.map(|(_, file, line, column)| SourceLocation {
        file,
        line: Some(line),
        column,
    })
}

fn find_adjacent_pdb(artifact_path: &Utf8Path) -> Option<Utf8PathBuf> {
    let directory = artifact_path.parent()?;
    let stem = artifact_path.file_stem()?;
    let direct = directory.join(format!("{stem}.pdb"));
    if direct.exists() {
        return Some(direct);
    }

    let underscore = directory.join(format!("{}.pdb", stem.replace('-', "_")));
    if underscore.exists() {
        return Some(underscore);
    }

    let pdbs = std::fs::read_dir(directory.as_std_path())
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|entry| Utf8PathBuf::from_path_buf(entry.path()).ok())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("pdb"))
        })
        .collect::<Vec<_>>();

    if pdbs.len() == 1 {
        pdbs.into_iter().next()
    } else {
        None
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PdbSymbolError {
    #[error("failed to open PDB {path}: {source}")]
    Open {
        path: Utf8PathBuf,
        source: std::io::Error,
    },
    #[error("failed to parse PDB {path}: {message}")]
    Parse { path: Utf8PathBuf, message: String },
    #[error("failed to read PDB symbols: {0}")]
    ReadSymbols(String),
}
