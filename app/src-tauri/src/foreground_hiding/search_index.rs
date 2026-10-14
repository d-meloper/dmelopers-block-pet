//! Read-only local Windows Search program-shortcut metadata via its OLE DB provider.
//! Fixed SQL only; no user query, search UI, remote catalog or target execution.
use ::windows::{
    Win32::System::{
        Com::{
            CLSCTX_INPROC_SERVER, CoCreateInstance, DISPATCH_FLAGS, DISPATCH_METHOD,
            DISPATCH_PROPERTYGET, DISPATCH_PROPERTYPUT, DISPPARAMS, IDispatch,
        },
        Variant::VARIANT,
    },
    core::{BSTR, GUID, IUnknown, Interface, PCWSTR},
};
use std::path::PathBuf;

const QUERY: &str = "SELECT TOP 16385 System.ItemNameDisplay, System.ItemUrl, System.Link.TargetParsingPath FROM SYSTEMINDEX WHERE System.Kind = 'program' AND (System.FileExtension = '.lnk' OR System.FileExtension = '.url')";
// Windows SDK msado15.idl / ADODB.Connection. CLSIDFromProgID can register a
// missing ProgID; the fixed class identity instead fails without that write.
const ADO_CONNECTION: GUID = GUID::from_u128(0x00000514_0000_0010_8000_00aa006d2ea4);

pub struct IndexedShortcut {
    pub name: String,
    pub source_path: PathBuf,
    pub target: Option<String>,
}

fn invoke(
    object: &IDispatch,
    name: &str,
    flags: DISPATCH_FLAGS,
    mut args: Vec<VARIANT>,
) -> Result<VARIANT, ()> {
    let wide = crate::windows_process::wide(name);
    let mut id = 0;
    let zero = GUID::zeroed();
    unsafe {
        object
            .GetIDsOfNames(&zero, &PCWSTR(wide.as_ptr()), 1, 0, &mut id)
            .map_err(|_error| {
                #[cfg(test)]
                eprintln!("search_index member={name} HRESULT={:?}", _error.code());
            })?;
    }
    args.reverse();
    let mut put_id = -3i32; // DISPID_PROPERTYPUT, mandated by IDispatch.
    let putting = flags == DISPATCH_PROPERTYPUT;
    let params = DISPPARAMS {
        rgvarg: args.as_mut_ptr(),
        cArgs: args.len() as u32,
        rgdispidNamedArgs: if putting {
            &mut put_id
        } else {
            std::ptr::null_mut()
        },
        cNamedArgs: if putting { 1 } else { 0 },
    };
    let mut result = VARIANT::default();
    unsafe {
        object
            .Invoke(id, &zero, 0, flags, &params, Some(&mut result), None, None)
            .map_err(|_error| {
                #[cfg(test)]
                eprintln!("search_index invoke={name} HRESULT={:?}", _error.code());
            })?;
    }
    Ok(result)
}

struct Connection(IDispatch);
impl Drop for Connection {
    fn drop(&mut self) {
        let _ = invoke(&self.0, "Close", DISPATCH_METHOD, Vec::new());
    }
}
struct Recordset(IDispatch);
impl Drop for Recordset {
    fn drop(&mut self) {
        let _ = invoke(&self.0, "Close", DISPATCH_METHOD, Vec::new());
    }
}
fn object(value: &VARIANT) -> Result<IDispatch, ()> {
    // ADO returns VT_DISPATCH; VT_UNKNOWN is a different tagged union member.
    IDispatch::try_from(value)
        .or_else(|_| IUnknown::try_from(value).and_then(|value| value.cast()))
        .map_err(|_| ())
}
fn field(fields: &IDispatch, index: i32) -> Result<Option<String>, ()> {
    let item = object(&invoke(
        fields,
        "Item",
        DISPATCH_PROPERTYGET,
        vec![VARIANT::from(index)],
    )?)?;
    let value = invoke(&item, "Value", DISPATCH_PROPERTYGET, Vec::new())?;
    Ok(BSTR::try_from(&value)
        .ok()
        .map(|value| value.to_string())
        .filter(|value| !value.is_empty()))
}
fn local_path(url: &str) -> Option<PathBuf> {
    use windows_sys::Win32::UI::Shell::PathCreateFromUrlW;
    if !url.to_ascii_lowercase().starts_with("file:") || url.contains('\0') {
        return None;
    }
    let wide = crate::windows_process::wide(url);
    let mut path = vec![0u16; 32768];
    let mut length = path.len() as u32;
    if unsafe { PathCreateFromUrlW(wide.as_ptr(), path.as_mut_ptr(), &mut length, 0) } < 0 {
        return None;
    }
    let end = path.iter().position(|value| *value == 0)?;
    let path = PathBuf::from(String::from_utf16(&path[..end]).ok()?);
    // The fixed index is local. Never consume a remote file URL or an arbitrary type.
    let text = path.to_str()?;
    let bytes = text.as_bytes();
    if bytes.len() < 3 || !bytes[0].is_ascii_alphabetic() || &bytes[1..3] != b":\\" {
        return None;
    }
    path.extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("lnk") || ext.eq_ignore_ascii_case("url"))
        .then_some(path)
}

/// Caller owns an initialized STA. Provider failure never invalidates other sources.
pub fn enumerate(mut on_shortcut: impl FnMut(IndexedShortcut) -> Result<(), ()>) -> Result<(), ()> {
    let connection = Connection(unsafe {
        CoCreateInstance(&ADO_CONNECTION, None, CLSCTX_INPROC_SERVER).map_err(|_| ())?
    });
    invoke(
        &connection.0,
        "Mode",
        DISPATCH_PROPERTYPUT,
        vec![VARIANT::from(1i32)],
    )?; // ADO adModeRead.
    invoke(
        &connection.0,
        "ConnectionTimeout",
        DISPATCH_PROPERTYPUT,
        vec![VARIANT::from(5i32)],
    )?;
    invoke(
        &connection.0,
        "CommandTimeout",
        DISPATCH_PROPERTYPUT,
        vec![VARIANT::from(10i32)],
    )?;
    invoke(
        &connection.0,
        "Open",
        DISPATCH_METHOD,
        vec![VARIANT::from(
            "Provider=Search.CollatorDSO.1;Extended Properties='Application=Windows';",
        )],
    )?;
    let rows = Recordset(object(&invoke(
        &connection.0,
        "Execute",
        DISPATCH_METHOD,
        vec![VARIANT::from(QUERY)],
    )?)?);
    let fields = object(&invoke(
        &rows.0,
        "Fields",
        DISPATCH_PROPERTYGET,
        Vec::new(),
    )?)?;
    for index in 0..16385 {
        if bool::try_from(&invoke(&rows.0, "EOF", DISPATCH_PROPERTYGET, Vec::new())?)
            .map_err(|_| ())?
        {
            return Ok(());
        }
        if index == 16384 {
            return Err(());
        }
        let name = field(&fields, 0)?.unwrap_or_default();
        let url = field(&fields, 1)?;
        let target = field(&fields, 2)?;
        if let Some(path) = url.as_deref().and_then(local_path)
            && path.is_file()
        {
            // Ignore stale index locations; a cached display path may be localized.
            on_shortcut(IndexedShortcut {
                name,
                source_path: path,
                target,
            })?;
        }
        invoke(&rows.0, "MoveNext", DISPATCH_METHOD, Vec::new())?;
    }
    Err(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automation_objects_accept_dispatch_variants_without_union_reinterpretation() {
        use ::windows::Win32::System::Com::{
            COINIT_APARTMENTTHREADED, CoInitializeEx, CoUninitialize,
        };
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().unwrap() };
        {
            let connection: IDispatch =
                unsafe { CoCreateInstance(&ADO_CONNECTION, None, CLSCTX_INPROC_SERVER).unwrap() };
            assert!(object(&VARIANT::from(connection.clone())).is_ok());
            assert!(object(&VARIANT::from(connection.cast::<IUnknown>().unwrap())).is_ok());
            assert!(object(&VARIANT::from("not an object")).is_err());
        }
        unsafe { CoUninitialize() };
    }

    #[test]
    #[ignore = "Explicit read-only local Windows Search provider smoke"]
    fn current_pc_search_provider_smoke() {
        use ::windows::Win32::System::Com::{
            COINIT_APARTMENTTHREADED, CoInitializeEx, CoUninitialize,
        };
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().unwrap() };
        let mut count = 0;
        let mut league = 0;
        let result = enumerate(|row| {
            count += 1;
            if row.name.to_lowercase().contains("league of legends") {
                league += 1;
            }
            Ok(())
        });
        unsafe { CoUninitialize() };
        println!(
            "index_rows={count} league_rows={league} complete={}",
            result.is_ok()
        );
        result.unwrap();
        if std::env::var_os("DMELOPER_CATALOG_EXPECT_LEAGUE").is_some() {
            assert!(league > 0);
        }
    }

    #[test]
    fn indexed_locations_use_windows_url_decoding_and_exclude_remote_or_unrelated_files() {
        assert_eq!(
            local_path("file:C:/ProgramData/Game%20Folder/Game.lnk").unwrap(),
            PathBuf::from(r"C:\ProgramData\Game Folder\Game.lnk")
        );
        for url in [
            "https://example.com/game.lnk",
            "file://server/share/game.lnk",
            "file:C:/TestData/document.docx",
        ] {
            assert!(local_path(url).is_none());
        }
    }
}
