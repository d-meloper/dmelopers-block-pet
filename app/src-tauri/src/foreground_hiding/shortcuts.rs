//! Read-only launch metadata from current-user and common Windows shortcuts.
//! Links are loaded through the Shell; they are never resolved, repaired or run.
use ::windows::{
    Win32::{
        Foundation::PROPERTYKEY,
        System::{
            Com::{
                CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
                CoTaskMemFree, CoUninitialize, IPersistFile, STGM_READ, STGM_SHARE_DENY_NONE,
                StructuredStorage::{PROPVARIANT, PropVariantClear, PropVariantToStringAlloc},
            },
            Variant::VT_EMPTY,
        },
        UI::Shell::{
            CLSID_InternetShortcut, IShellLinkW, IUniformResourceLocatorW,
            PropertiesSystem::IPropertyStore, SLGP_RAWPATH, ShellLink,
        },
    },
    core::{GUID, Interface, PCWSTR, PWSTR},
};
use std::{
    collections::{HashSet, VecDeque},
    fs,
    io::ErrorKind,
    os::windows::{ffi::OsStrExt, fs::MetadataExt},
    path::{Path, PathBuf},
};
use windows_sys::{
    Win32::{
        Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT,
        System::Environment::ExpandEnvironmentStringsW,
        UI::Shell::{
            FOLDERID_CommonPrograms, FOLDERID_Desktop, FOLDERID_Programs, FOLDERID_PublicDesktop,
            KF_FLAG_DONT_VERIFY, SHGetKnownFolderPath,
        },
    },
    core::GUID as KnownFolderId,
};

// propkey.h / System.Link.Arguments. The allocated property avoids the silent
// truncation documented for IShellLinkW::GetArguments on Windows 7 and later.
const LINK_ARGUMENTS: PROPERTYKEY = PROPERTYKEY {
    fmtid: GUID::from_u128(0x436f2667_14e2_4feb_b30a_146c53b5b674),
    pid: 100,
};
const MAX_TEXT: usize = 32768;
const MAX_LINK_BYTES: u64 = 2 * 1024 * 1024;
const MAX_ENTRIES: usize = 65536;
const MAX_DEPTH: usize = 64;

// Raw targets and arguments are native transient catalog inputs, not diagnostic
// or frontend output. Do not serialize them or infer executable matching from a URI.
#[derive(Clone, PartialEq, Eq)]
pub struct Shortcut {
    pub name: String,
    pub target: String,
    pub arguments: String,
    pub source_path: String,
}

struct Apartment;
impl Apartment {
    fn new() -> Result<Self, ()> {
        unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED)
                .ok()
                .map_err(|_| ())?;
        }
        Ok(Self)
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}
struct PropertyValue(PROPVARIANT);
impl Drop for PropertyValue {
    fn drop(&mut self) {
        unsafe {
            let _ = PropVariantClear(&mut self.0);
        }
    }
}

fn take_string(value: PWSTR) -> Result<String, ()> {
    if value.0.is_null() {
        return Ok(String::new());
    }
    let result = unsafe { value.to_string().map_err(|_| ()) };
    unsafe { CoTaskMemFree(Some(value.0.cast())) };
    result
}

fn known_folder(id: &KnownFolderId) -> Result<PathBuf, ()> {
    let mut value = std::ptr::null_mut();
    let status = unsafe {
        SHGetKnownFolderPath(
            id,
            KF_FLAG_DONT_VERIFY as u32,
            std::ptr::null_mut(),
            &mut value,
        )
    };
    // SHGetKnownFolderPath requires freeing the out pointer even on failure.
    if status < 0 || value.is_null() {
        unsafe { CoTaskMemFree(Some(value.cast())) };
        return Err(());
    }
    let path = take_string(PWSTR(value))?;
    if path.is_empty() {
        Err(())
    } else {
        Ok(PathBuf::from(path))
    }
}

fn text(buffer: &[u16]) -> Option<String> {
    let length = buffer.iter().position(|value| *value == 0)?;
    // A full buffer might be silently truncated by an older Shell provider.
    if length + 1 == buffer.len() {
        return None;
    }
    String::from_utf16(&buffer[..length]).ok()
}

fn normalize_target(raw: &str) -> Option<String> {
    let raw = raw.trim();
    let raw = raw
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .unwrap_or(raw);
    if raw.is_empty() || raw.contains('"') || raw.chars().any(|value| value < ' ') {
        return None;
    }
    let input: Vec<u16> = raw.encode_utf16().chain(Some(0)).collect();
    let required = unsafe { ExpandEnvironmentStringsW(input.as_ptr(), std::ptr::null_mut(), 0) };
    if required == 0 || required as usize > MAX_TEXT {
        return None;
    }
    let mut output = vec![0u16; required as usize + 1];
    let written = unsafe {
        ExpandEnvironmentStringsW(input.as_ptr(), output.as_mut_ptr(), output.len() as u32)
    };
    if written == 0 || written as usize > output.len() {
        return None;
    }
    let path = text(&output)?;
    Some(if Path::new(&path).is_absolute() {
        path.replace('/', "\\")
    } else {
        path
    })
}

fn arguments(link: &IShellLinkW) -> Option<String> {
    if let Ok(store) = link.cast::<IPropertyStore>()
        && let Ok(value) = unsafe { store.GetValue(&LINK_ARGUMENTS) }
    {
        let value = PropertyValue(value);
        if unsafe { value.0.Anonymous.Anonymous.vt } == VT_EMPTY {
            return Some(String::new());
        }
        if let Ok(allocated) = unsafe { PropVariantToStringAlloc(&value.0) }
            && let Ok(value) = take_string(allocated)
        {
            return (value.encode_utf16().count() < MAX_TEXT).then_some(value);
        }
    }
    // Compatibility fallback: grow the buffer rather than accept a full buffer.
    let mut size = 256;
    loop {
        let mut buffer = vec![u16::MAX; size];
        unsafe { link.GetArguments(&mut buffer).ok()? };
        if let Some(value) = text(&buffer) {
            return Some(value);
        }
        if size == MAX_TEXT {
            return None;
        }
        size = (size * 2).min(MAX_TEXT);
    }
}

fn shell_link(filename: PCWSTR) -> Option<(String, String)> {
    let link: IShellLinkW =
        unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()? };
    let file: IPersistFile = link.cast().ok()?;
    unsafe {
        file.Load(filename, STGM_READ | STGM_SHARE_DENY_NONE).ok()?;
    }
    let mut target = vec![u16::MAX; MAX_TEXT];
    let target = unsafe {
        link.GetPath(&mut target, std::ptr::null_mut(), SLGP_RAWPATH.0 as u32)
            .ok()
    }
    .and_then(|_| text(&target))
    .and_then(|raw| normalize_target(&raw))
    .unwrap_or_default();
    // A valid, unresolved link keeps its named catalog entry. Failed argument
    // metadata also leaves it unresolved rather than inventing a launcher identity.
    Some(match arguments(&link) {
        Some(arguments) => (target, arguments),
        None => (String::new(), String::new()),
    })
}

fn internet_link(filename: PCWSTR) -> Option<(String, String)> {
    let link: IUniformResourceLocatorW =
        unsafe { CoCreateInstance(&CLSID_InternetShortcut, None, CLSCTX_INPROC_SERVER).ok()? };
    let file: IPersistFile = link.cast().ok()?;
    unsafe { file.Load(filename, STGM_READ | STGM_SHARE_DENY_NONE).ok()? };
    let target = unsafe { link.GetURL().ok() }
        .and_then(|value| take_string(value).ok())
        .filter(|value| {
            value.encode_utf16().count() < MAX_TEXT && !value.chars().any(|value| value < ' ')
        })
        .unwrap_or_default();
    Some((target, String::new()))
}

fn read_shortcut(path: &Path, metadata: &fs::Metadata) -> Option<Shortcut> {
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_LINK_BYTES {
        return None;
    }
    let name = path.file_stem()?.to_str()?.trim().to_owned();
    if name.is_empty() {
        return None;
    }
    let filename: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let filename = PCWSTR(filename.as_ptr());
    let (target, arguments) = if path.extension()?.eq_ignore_ascii_case("url") {
        internet_link(filename)?
    } else {
        shell_link(filename)?
    };
    // Web bookmarks are not installed programs. Keep game/app protocols only as
    // unresolved named entries; no URI is invoked or treated as an EXE rule.
    let lower = target.to_ascii_lowercase();
    if ["http:", "https:", "ftp:", "mailto:", "file:"]
        .iter()
        .any(|scheme| lower.starts_with(scheme))
    {
        return None;
    }
    Some(Shortcut {
        name,
        target,
        arguments,
        source_path: path.to_str()?.to_owned(),
    })
}

/// Read one explicit local index result; this does not traverse its parent tree.
/// Caller owns the STA. Windows Search already supplies the accessible file location.
pub(super) fn read_indexed(path: &Path) -> Option<Shortcut> {
    let metadata = fs::metadata(path).ok()?;
    read_shortcut(path, &metadata)
}

fn enumerate_roots(
    roots: impl IntoIterator<Item = PathBuf>,
    max_depth: usize,
    mut on_shortcut: impl FnMut(Shortcut) -> Result<(), ()>,
) -> Result<(), ()> {
    let mut directories: VecDeque<_> = roots.into_iter().map(|path| (path, 0usize)).collect();
    let mut seen = HashSet::new();
    let mut complete = true;
    let mut entries = 0usize;
    while let Some((directory, depth)) = directories.pop_front() {
        // Redirected network known folders are not automatically traversed.
        let local = directory.to_str().is_some_and(|value| {
            let bytes = value.as_bytes();
            bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && &bytes[1..3] == b":\\"
        });
        if !local {
            complete = false;
            continue;
        }
        if !seen.insert(directory.clone()) {
            continue;
        }
        let metadata = match fs::symlink_metadata(&directory) {
            Ok(value) => value,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(_) => {
                complete = false;
                continue;
            }
        };
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            continue;
        }
        if !metadata.is_dir() {
            complete = false;
            continue;
        }
        let children = match fs::read_dir(&directory) {
            Ok(value) => value,
            Err(_) => {
                complete = false;
                continue;
            }
        };
        for entry in children {
            entries += 1;
            if entries > MAX_ENTRIES {
                return Err(());
            }
            let entry = match entry {
                Ok(value) => value,
                Err(_) => {
                    complete = false;
                    continue;
                }
            };
            let path = entry.path();
            let metadata = match fs::symlink_metadata(&path) {
                Ok(value) => value,
                Err(_) => {
                    complete = false;
                    continue;
                }
            };
            if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                continue;
            }
            if metadata.is_dir() {
                if depth < max_depth {
                    directories.push_back((path, depth + 1));
                } else if max_depth != 0 {
                    complete = false;
                }
            } else if path.extension().is_some_and(|value| {
                value.eq_ignore_ascii_case("lnk") || value.eq_ignore_ascii_case("url")
            }) && let Some(shortcut) = read_shortcut(&path, &metadata)
            {
                on_shortcut(shortcut)?;
            }
        }
    }
    if complete { Ok(()) } else { Err(()) }
}

/// Streams independent launcher entries; no executable-only deduplication.
/// An error means cancellation or incomplete source traversal. Already delivered
/// entries remain usable. Unreadable/malformed links are skipped individually.
/// Loaded links with unsupported/unresolved targets retain their names and source
/// identities; callers must validate targets before enabling executable selection.
pub fn enumerate(mut on_shortcut: impl FnMut(Shortcut) -> Result<(), ()>) -> Result<(), ()> {
    let _apartment = Apartment::new()?;
    let mut complete = true;
    let mut roots = Vec::new();
    for (id, depth) in [
        (FOLDERID_Programs, MAX_DEPTH),
        (FOLDERID_CommonPrograms, MAX_DEPTH),
        (FOLDERID_Desktop, 0),
        (FOLDERID_PublicDesktop, 0),
    ] {
        match known_folder(&id) {
            Ok(path) => roots.push((path, depth)),
            Err(()) => complete = false,
        }
    }
    // Desktop roots are shallow: nested program shortcuts come from the existing
    // Windows Search index, avoiding repository/cache and personal-folder scans.
    // A bounded/unreadable source must
    // not prevent other known folders from contributing their independent rows.
    let mut seen = HashSet::new();
    for (root, depth) in roots {
        if !seen.insert(root.clone()) {
            continue;
        }
        let mut cancelled = false;
        if enumerate_roots([root], depth, |shortcut| {
            let result = on_shortcut(shortcut);
            cancelled = result.is_err();
            result
        })
        .is_err()
        {
            if cancelled {
                return Err(());
            }
            complete = false;
        }
    }
    if complete { Ok(()) } else { Err(()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_link(path: &Path, target: &str, arguments: &str) {
        let link: IShellLinkW =
            unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).unwrap() };
        let target: Vec<u16> = target.encode_utf16().chain(Some(0)).collect();
        let arguments: Vec<u16> = arguments.encode_utf16().chain(Some(0)).collect();
        let filename: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe {
            link.SetPath(PCWSTR(target.as_ptr())).unwrap();
            link.SetArguments(PCWSTR(arguments.as_ptr())).unwrap();
            link.cast::<IPersistFile>()
                .unwrap()
                .Save(PCWSTR(filename.as_ptr()), true)
                .unwrap();
        }
    }

    fn create_url_link(path: &Path, target: &str) {
        let link: IUniformResourceLocatorW = unsafe {
            CoCreateInstance(&CLSID_InternetShortcut, None, CLSCTX_INPROC_SERVER).unwrap()
        };
        let target: Vec<u16> = target.encode_utf16().chain(Some(0)).collect();
        let filename: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe {
            link.SetURL(PCWSTR(target.as_ptr()), 0).unwrap();
            link.cast::<IPersistFile>()
                .unwrap()
                .Save(PCWSTR(filename.as_ptr()), true)
                .unwrap();
        }
    }

    #[test]
    fn reads_real_launcher_link_without_changing_bytes_or_splitting_arguments() {
        let _apartment = Apartment::new().unwrap();
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("League of Legends 한글.lnk");
        let target = r"C:\Riot Games\Riot Client\RiotClientServices.exe";
        let arguments = "--launch-product=league_of_legends --launch-patchline=live";
        create_link(&path, &format!("\"{target}\""), arguments);
        let before = fs::read(&path).unwrap();
        let shortcut = read_shortcut(&path, &fs::metadata(&path).unwrap()).unwrap();
        assert_eq!(shortcut.name, "League of Legends 한글");
        assert_eq!(shortcut.target, target);
        assert_eq!(shortcut.arguments, arguments);
        assert_eq!(shortcut.source_path, path.to_str().unwrap());
        assert_eq!(fs::read(&path).unwrap(), before);
    }

    #[test]
    fn preserves_launcher_variants_and_skips_bad_links_in_nested_folders() {
        let _apartment = Apartment::new().unwrap();
        let folder = tempfile::tempdir().unwrap();
        let nested = folder.path().join("Games");
        fs::create_dir(&nested).unwrap();
        let target = r"C:\Riot Games\Riot Client\RiotClientServices.exe";
        create_link(
            &nested.join("League.lnk"),
            target,
            "--launch-product=league_of_legends",
        );
        create_link(
            &nested.join("Valorant.LNK"),
            target,
            "--launch-product=valorant",
        );
        fs::write(nested.join("Bad.lnk"), b"invalid shortcut").unwrap();
        fs::write(nested.join("Ignored.exe"), b"not inspected").unwrap();
        let mut shortcuts = Vec::new();
        enumerate_roots([folder.path().to_owned(), nested], MAX_DEPTH, |value| {
            shortcuts.push(value);
            Ok(())
        })
        .unwrap();
        shortcuts.sort_by(|left, right| left.name.cmp(&right.name));
        assert_eq!(shortcuts.len(), 2);
        assert_eq!(shortcuts[0].name, "League");
        assert_eq!(shortcuts[1].name, "Valorant");
        assert_eq!(shortcuts[0].target, shortcuts[1].target);
        assert_ne!(shortcuts[0].arguments, shortcuts[1].arguments);
    }

    #[test]
    fn preserves_long_arguments_without_a_fixed_legacy_buffer() {
        let _apartment = Apartment::new().unwrap();
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("Long.lnk");
        let arguments = format!("--profile=\"{}\"", "unicode-한글 ".repeat(500));
        create_link(&path, r"C:\Programs\Launcher.exe", &arguments);
        let shortcut = read_shortcut(&path, &fs::metadata(&path).unwrap()).unwrap();
        assert_eq!(shortcut.arguments, arguments);
    }

    #[test]
    fn retains_protocol_game_shortcuts_without_invoking_or_rewriting_them() {
        let _apartment = Apartment::new().unwrap();
        let folder = tempfile::tempdir().unwrap();
        let steam = folder.path().join("Steam Game.url");
        let epic = folder.path().join("Epic Game.URL");
        create_url_link(&folder.path().join("Website.url"), "https://example.com/");
        create_url_link(&steam, "steam://rungameid/123");
        create_url_link(&epic, "com.epicgames.launcher://apps/Example?action=launch");
        let before = [fs::read(&steam).unwrap(), fs::read(&epic).unwrap()];
        let mut shortcuts = Vec::new();
        enumerate_roots([folder.path().to_owned()], MAX_DEPTH, |value| {
            shortcuts.push(value);
            Ok(())
        })
        .unwrap();
        shortcuts.sort_by(|left, right| left.name.cmp(&right.name));
        assert_eq!(shortcuts.len(), 2);
        assert_eq!(
            shortcuts[0].target,
            "com.epicgames.launcher://apps/Example?action=launch"
        );
        assert_eq!(shortcuts[1].target, "steam://rungameid/123");
        assert!(shortcuts.iter().all(|value| value.arguments.is_empty()));
        assert_eq!(fs::read(&steam).unwrap(), before[0]);
        assert_eq!(fs::read(&epic).unwrap(), before[1]);
    }

    #[test]
    fn retains_valid_unresolved_and_non_executable_links() {
        let _apartment = Apartment::new().unwrap();
        let folder = tempfile::tempdir().unwrap();
        create_link(
            &folder.path().join("Unresolved.lnk"),
            "",
            "--profile=unknown",
        );
        create_link(
            &folder.path().join("Document.lnk"),
            r"C:\Docs\Readme.txt",
            "",
        );
        let mut shortcuts = Vec::new();
        enumerate_roots([folder.path().to_owned()], MAX_DEPTH, |value| {
            shortcuts.push(value);
            Ok(())
        })
        .unwrap();
        shortcuts.sort_by(|left, right| left.name.cmp(&right.name));
        assert_eq!(shortcuts.len(), 2);
        assert_eq!(shortcuts[0].name, "Document");
        assert_eq!(shortcuts[0].target, r"C:\Docs\Readme.txt");
        assert_eq!(shortcuts[1].name, "Unresolved");
        assert!(shortcuts[1].target.is_empty());
        assert_eq!(shortcuts[1].arguments, "--profile=unknown");
    }

    #[test]
    fn reports_partial_sources_after_delivering_usable_entries() {
        let _apartment = Apartment::new().unwrap();
        let folder = tempfile::tempdir().unwrap();
        create_link(
            &folder.path().join("Valid.lnk"),
            r"C:\Programs\Valid.exe",
            "",
        );
        let wrong_root = folder.path().join("not-a-directory");
        fs::write(&wrong_root, b"file").unwrap();
        let mut shortcuts = Vec::new();
        let outcome = enumerate_roots(
            [
                folder.path().to_owned(),
                folder.path().join("absent"),
                wrong_root,
            ],
            MAX_DEPTH,
            |value| {
                shortcuts.push(value);
                Ok(())
            },
        );
        assert_eq!(outcome, Err(()));
        assert_eq!(shortcuts.len(), 1);
        assert_eq!(shortcuts[0].name, "Valid");
    }

    #[test]
    fn shallow_desktop_source_does_not_visit_personal_subdirectories() {
        let _apartment = Apartment::new().unwrap();
        let folder = tempfile::tempdir().unwrap();
        let nested = folder.path().join("Repository");
        fs::create_dir(&nested).unwrap();
        create_link(
            &folder.path().join("Direct.lnk"),
            r"C:\Programs\App.exe",
            "",
        );
        create_link(&nested.join("Nested.lnk"), r"C:\Programs\App.exe", "");
        let mut names = Vec::new();
        enumerate_roots([folder.path().to_owned()], 0, |row| {
            names.push(row.name);
            Ok(())
        })
        .unwrap();
        assert_eq!(names, ["Direct"]);
    }

    #[test]
    fn callback_cancellation_stops_delivery() {
        let _apartment = Apartment::new().unwrap();
        let folder = tempfile::tempdir().unwrap();
        for name in ["First", "Second"] {
            create_link(
                &folder.path().join(format!("{name}.lnk")),
                r"C:\Programs\App.exe",
                "",
            );
        }
        let mut calls = 0;
        assert_eq!(
            enumerate_roots([folder.path().to_owned()], MAX_DEPTH, |_| {
                calls += 1;
                Err(())
            }),
            Err(())
        );
        assert_eq!(calls, 1);
    }

    #[test]
    fn skips_directory_reparse_points_instead_of_scanning_their_targets() {
        let _apartment = Apartment::new().unwrap();
        let folder = tempfile::tempdir().unwrap();
        let root = folder.path().join("Programs");
        let outside = folder.path().join("Outside");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&outside).unwrap();
        create_link(&root.join("Included.lnk"), r"C:\Programs\App.exe", "");
        create_link(&outside.join("Excluded.lnk"), r"C:\Programs\App.exe", "");
        std::os::windows::fs::symlink_dir(&outside, root.join("Reparse")).unwrap();
        let mut shortcuts = Vec::new();
        enumerate_roots([root], MAX_DEPTH, |value| {
            shortcuts.push(value);
            Ok(())
        })
        .unwrap();
        assert_eq!(shortcuts.len(), 1);
        assert_eq!(shortcuts[0].name, "Included");
    }

    #[test]
    fn normalizes_metadata_fields_without_parsing_a_combined_command_line() {
        let target = r"C:\Riot Games\Riot Client\RiotClientServices.exe";
        assert_eq!(
            normalize_target(&format!("\"{target}\"")),
            Some(target.to_owned())
        );
        assert_eq!(
            normalize_target(&format!("\"{target}\" --launch-product=league_of_legends")),
            None
        );
        assert_eq!(
            normalize_target("relative.exe"),
            Some("relative.exe".to_owned())
        );
        assert_eq!(
            normalize_target("steam://rungameid/123"),
            Some("steam://rungameid/123".to_owned())
        );
        assert_eq!(
            normalize_target("C:\\Readme.txt"),
            Some("C:\\Readme.txt".to_owned())
        );
        assert_eq!(text(&[65, 0]), None);
    }

    #[test]
    #[ignore = "read-only current-PC discovery; run only for an explicitly requested native sample"]
    fn actual_known_folder_league_sample() {
        let mut count = 0;
        let mut league = false;
        let mut exact_launcher = false;
        let mut exact_arguments = false;
        let outcome = enumerate(|shortcut| {
            count += 1;
            if shortcut
                .name
                .to_ascii_lowercase()
                .contains("league of legends")
                || shortcut
                    .arguments
                    .contains("--launch-product=league_of_legends")
            {
                league = true;
                exact_launcher |= shortcut
                    .target
                    .eq_ignore_ascii_case(r"C:\Riot Games\Riot Client\RiotClientServices.exe");
                exact_arguments |= shortcut.arguments
                    == "--launch-product=league_of_legends --launch-patchline=live";
            }
            Ok(())
        });
        println!(
            "known-folder sample: complete={} entries={} league={} exact_launcher={} exact_arguments={}",
            outcome.is_ok(),
            count,
            league,
            exact_launcher,
            exact_arguments
        );
        assert!(league && exact_launcher && exact_arguments);
    }
}
