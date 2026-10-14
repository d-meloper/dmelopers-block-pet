//! Installed Shell applications and icons, read only when Preferences requests them.
use ::windows::{
    Data::Xml::Dom::XmlDocument,
    Management::Deployment::PackageManager,
    Win32::{
        Foundation::{PROPERTYKEY, SIZE},
        Graphics::Gdi::{
            BI_RGB, BITMAP, BITMAPINFO, CreateCompatibleDC, DIB_RGB_COLORS, DeleteDC, DeleteObject,
            GetDIBits, GetObjectW, HBITMAP, HGDIOBJ,
        },
        System::{
            Com::CoTaskMemFree,
            WinRT::{RO_INIT_SINGLETHREADED, RoInitialize, RoUninitialize},
        },
        UI::Shell::{
            BHID_EnumItems, IEnumShellItems, IShellItem, IShellItem2, IShellItemImageFactory,
            SHCreateItemFromParsingName, SIGDN_NORMALDISPLAY, SIIGBF, SIIGBF_ICONONLY,
            SIIGBF_INCACHEONLY,
        },
    },
    core::{GUID, HSTRING, Interface, PCWSTR, PWSTR},
};
use base64::Engine;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    io::Cursor,
    path::Path,
};

// Windows property keys from propkey.h, not persisted selection identifiers.
const TARGET_PATH: PROPERTYKEY = PROPERTYKEY {
    fmtid: GUID::from_u128(0xb9b4b3fc_2b51_4a42_b5d8_324146afcf25),
    pid: 2,
};
const APP_ID: PROPERTYKEY = PROPERTYKEY {
    fmtid: GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
    pid: 5,
};
const FILE_DESCRIPTION: PROPERTYKEY = PROPERTYKEY {
    fmtid: GUID::from_u128(0x0cef7d53_fa64_11d1_a203_0000f81fedee),
    pid: 3,
};
const RELAUNCH_COMMAND: PROPERTYKEY = PROPERTYKEY {
    fmtid: GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
    pid: 2,
};

const CATALOG_LIMIT: usize = 16384;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Application {
    pub id: String,
    pub path: String,
    pub name: String,
    pub icon: Option<String>,
    pub launch_options: bool,
}

#[derive(Serialize)]
pub struct Catalog {
    pub items: Vec<Application>,
    pub incomplete: bool,
    pub truncated: bool,
}

struct Apartment;
impl Apartment {
    fn new() -> Result<Self, ()> {
        unsafe {
            RoInitialize(RO_INIT_SINGLETHREADED).map_err(|_| ())?;
        }
        Ok(Self)
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            RoUninitialize();
        }
    }
}
struct Bitmap(HBITMAP);
impl Drop for Bitmap {
    fn drop(&mut self) {
        unsafe {
            let _ = DeleteObject(HGDIOBJ(self.0.0));
        }
    }
}

fn take_string(value: PWSTR) -> String {
    let text = unsafe { value.to_string().unwrap_or_default() };
    unsafe {
        CoTaskMemFree(Some(value.0.cast()));
    }
    text
}
fn property(item: &IShellItem, key: &PROPERTYKEY) -> Option<String> {
    let extended: IShellItem2 = item.cast().ok()?;
    let value = take_string(unsafe { extended.GetString(key).ok()? });
    if value.is_empty() { None } else { Some(value) }
}
fn shell_item(path: &str) -> Option<IShellItem> {
    let wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
    unsafe { SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None).ok() }
}

fn icon(item: &IShellItem) -> Option<String> {
    image(item, SIIGBF_ICONONLY)
}

fn image(item: &IShellItem, flags: SIIGBF) -> Option<String> {
    let factory: IShellItemImageFactory = item.cast().ok()?;
    let bitmap = Bitmap(unsafe { factory.GetImage(SIZE { cx: 32, cy: 32 }, flags).ok()? });
    let mut dimensions = BITMAP::default();
    if unsafe {
        GetObjectW(
            HGDIOBJ(bitmap.0.0),
            std::mem::size_of::<BITMAP>() as i32,
            Some((&mut dimensions as *mut BITMAP).cast()),
        )
    } == 0
    {
        return None;
    }
    let width = dimensions.bmWidth;
    let height = dimensions.bmHeight.checked_abs()?;
    if width <= 0 || height <= 0 || width > 128 || height > 128 {
        return None;
    }
    let mut info = BITMAPINFO::default();
    info.bmiHeader.biSize = std::mem::size_of_val(&info.bmiHeader) as u32;
    info.bmiHeader.biWidth = width;
    info.bmiHeader.biHeight = -height;
    info.bmiHeader.biPlanes = 1;
    info.bmiHeader.biBitCount = 32;
    info.bmiHeader.biCompression = BI_RGB.0;
    let mut pixels = vec![0u8; width as usize * height as usize * 4];
    let dc = unsafe { CreateCompatibleDC(None) };
    if dc.0.is_null() {
        return None;
    }
    let rows = unsafe {
        GetDIBits(
            dc,
            bitmap.0,
            0,
            height as u32,
            Some(pixels.as_mut_ptr().cast()),
            &mut info,
            DIB_RGB_COLORS,
        )
    };
    unsafe {
        let _ = DeleteDC(dc);
    }
    if rows != height {
        return None;
    }
    let has_alpha = pixels.chunks_exact(4).any(|pixel| pixel[3] != 0);
    for pixel in pixels.chunks_exact_mut(4) {
        pixel.swap(0, 2);
        if !has_alpha {
            pixel[3] = 255;
        } else if pixel[3] > 0 && pixel[3] < 255 {
            for channel in 0..3 {
                pixel[channel] = (pixel[channel] as u32 * 255 / pixel[3] as u32).min(255) as u8;
            }
        }
    }
    let image = image::RgbaImage::from_raw(width as u32, height as u32, pixels)?;
    let mut png = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image)
        .write_to(&mut png, image::ImageFormat::Png)
        .ok()?;
    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png.into_inner())
    ))
}

fn packaged_paths() -> Result<HashMap<String, String>, ()> {
    let mut paths = HashMap::new();
    let manager = PackageManager::new().map_err(|_| ())?;
    let packages = manager
        .FindPackagesByUserSecurityId(&HSTRING::new())
        .map_err(|_| ())?;
    for package in packages {
        let mapped = (|| -> Option<()> {
            if package.IsFramework().ok()? {
                return None;
            }
            let family = package.Id().ok()?.FamilyName().ok()?.to_string();
            let location = package.InstalledLocation().ok()?.Path().ok()?.to_string();
            let manifest = Path::new(&location).join("AppxManifest.xml");
            if std::fs::metadata(&manifest).ok()?.len() > 2 * 1024 * 1024 {
                return None;
            }
            let xml = std::fs::read_to_string(manifest).ok()?;
            let document = XmlDocument::new().ok()?;
            document.LoadXml(&HSTRING::from(xml)).ok()?;
            let applications = document
                .SelectNodes(&HSTRING::from("//*[local-name()='Application']"))
                .ok()?;
            for index in 0..applications.Length().ok()?.min(128) {
                let attributes = applications.Item(index).ok()?.Attributes().ok()?;
                let Some(id) = attributes
                    .GetNamedItem(&HSTRING::from("Id"))
                    .ok()
                    .and_then(|value| value.InnerText().ok())
                else {
                    continue;
                };
                let Some(executable) = attributes
                    .GetNamedItem(&HSTRING::from("Executable"))
                    .ok()
                    .and_then(|value| value.InnerText().ok())
                else {
                    continue;
                };
                let path = Path::new(&location)
                    .join(executable.to_string().replace('/', "\\"))
                    .to_string_lossy()
                    .into_owned();
                if super::model::valid_application(&path) {
                    paths.insert(format!("{}!{}", family, id).to_lowercase(), path);
                }
            }
            Some(())
        })();
        let _ = mapped;
    }
    Ok(paths)
}

fn package_path(
    cached: &mut Option<HashMap<String, String>>,
    incomplete: &mut bool,
    app_id: &str,
    load: impl FnOnce() -> Result<HashMap<String, String>, ()>,
) -> Option<String> {
    cached
        .get_or_insert_with(|| load().unwrap_or_else(|_| {
            *incomplete = true;
            HashMap::new()
        }))
        .get(&app_id.to_lowercase())
        .cloned()
}

fn arguments(value: &str) -> Option<Vec<String>> {
    use windows_sys::Win32::{Foundation::LocalFree, UI::Shell::CommandLineToArgvW};
    if value.is_empty() || value.contains('\0') || value.encode_utf16().count() > 32767 {
        return None;
    }
    let wide = crate::windows_process::wide(value.trim());
    let mut count = 0;
    let allocation = unsafe { CommandLineToArgvW(wide.as_ptr(), &mut count) };
    if allocation.is_null() {
        return None;
    }
    let result = (|| {
        if count <= 0 || count > 32768 {
            return None;
        }
        let mut result = Vec::new();
        for index in 0..count as usize {
            let value = unsafe { *allocation.add(index) };
            if value.is_null() {
                return None;
            }
            let mut length = 0;
            while length < 32768 && unsafe { *value.add(length) } != 0 {
                length += 1;
            }
            if length == 32768 {
                return None;
            }
            result.push(
                String::from_utf16(unsafe { std::slice::from_raw_parts(value, length) }).ok()?,
            );
        }
        Some(result)
    })();
    unsafe {
        LocalFree(allocation.cast());
    }
    result
}

fn executable(value: &str) -> Option<String> {
    let expanded = super::app_paths::expand(value)?;
    let expanded = expanded.trim();
    let unquoted = expanded
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .unwrap_or(expanded);
    let mut path = unquoted.replace('/', "\\");
    if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        path = format!(r"\\{}", unc);
    } else if let Some(normal) = path.strip_prefix(r"\\?\") {
        path = normal.to_owned();
    }
    // Automatic discovery does not probe remote executables or network shares.
    // Explicit saved/manual rules retain their existing validation elsewhere.
    let bytes = path.as_bytes();
    (bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && &bytes[1..3] == b":\\"
        && super::model::valid_application(&path)
        && Path::new(&path).is_file())
    .then_some(path)
}

fn command(value: &str) -> Option<(String, Vec<String>)> {
    let mut parts = arguments(value)?;
    let path = executable(parts.first()?)?;
    parts.remove(0);
    Some((path, parts))
}

fn identity(name: &str, path: &str, launch_arguments: &[String], fallback: &str) -> String {
    let mut hash = Sha256::new();
    for value in [
        name.trim().to_lowercase(),
        path.to_lowercase(),
        if path.is_empty() {
            fallback.to_lowercase()
        } else {
            String::new()
        },
    ]
    .into_iter()
    .chain(launch_arguments.iter().cloned())
    {
        hash.update((value.len() as u64).to_le_bytes());
        hash.update(value.as_bytes());
    }
    format!("{:x}", hash.finalize())
}

struct Collector<F> {
    items: Vec<Application>,
    seen: HashSet<String>,
    paths: HashSet<String>,
    on_application: F,
    truncated: bool,
    delivery_failed: bool,
}
impl<F: FnMut(&Application) -> Result<(), ()>> Collector<F> {
    fn add(
        &mut self,
        name: String,
        path: Option<String>,
        launch_arguments: Vec<String>,
        fallback: &str,
        item: Option<&IShellItem>,
    ) -> Result<(), ()> {
        let path = path.unwrap_or_default();
        let id = identity(&name, &path, &launch_arguments, fallback);
        if !self.seen.insert(id.clone()) {
            return Ok(());
        }
        if self.items.len() >= CATALOG_LIMIT {
            self.truncated = true;
            return Ok(());
        }
        let icon = if path.is_empty() {
            None
        } else {
            // A shortcut can point at an external icon resource. Its Shell image
            // is cache-only; extraction fallback uses the verified local EXE.
            item.and_then(|item| image(item, SIIGBF_ICONONLY | SIIGBF_INCACHEONLY))
                .or_else(|| shell_item(&path).as_ref().and_then(icon))
        };
        let row = Application {
            id,
            path,
            name,
            icon,
            launch_options: !launch_arguments.is_empty(),
        };
        if (self.on_application)(&row).is_err() {
            self.delivery_failed = true;
            return Err(());
        }
        if !row.path.is_empty() {
            self.paths.insert(row.path.to_lowercase());
        }
        self.items.push(row);
        Ok(())
    }
}

fn shell_applications(
    on_application: &mut impl FnMut(
        String,
        Option<String>,
        Vec<String>,
        String,
        &IShellItem,
    ) -> Result<(), ()>,
) -> Result<(), ()> {
    let root = shell_item("shell:AppsFolder").ok_or(())?;
    let items: IEnumShellItems =
        unsafe { root.BindToHandler(None, &BHID_EnumItems).map_err(|_| ())? };
    let mut packages = None;
    let mut incomplete = false;
    for index in 0..65536 {
        let mut next = [None];
        let mut fetched = 0;
        unsafe {
            items.Next(&mut next, Some(&mut fetched)).map_err(|_| ())?;
        }
        if fetched == 0 {
            return if incomplete { Err(()) } else { Ok(()) };
        }
        let Some(item) = next[0].take() else {
            continue;
        };
        let app_id = property(&item, &APP_ID).unwrap_or_default();
        let mut launch_arguments = Vec::new();
        let path = property(&item, &TARGET_PATH)
            .and_then(|value| {
                executable(&value).or_else(|| {
                    command(&value).map(|(path, args)| {
                        launch_arguments = args;
                        path
                    })
                })
            })
            .or_else(|| {
                property(&item, &RELAUNCH_COMMAND)
                    .and_then(|value| command(&value))
                    .map(|(path, args)| {
                        launch_arguments = args;
                        path
                    })
            })
            .or_else(|| {
                if app_id.is_empty() {
                    return None;
                }
                package_path(&mut packages, &mut incomplete, &app_id, packaged_paths)
                    .and_then(|path| executable(&path))
            });
        let name = unsafe { item.GetDisplayName(SIGDN_NORMALDISPLAY).ok() }
            .map(take_string)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| {
                path.as_deref()
                    .map(display_name)
                    .unwrap_or_else(|| "Application".into())
            });
        on_application(name, path, launch_arguments, app_id, &item)?;
        if index == 65535 {
            return Err(());
        }
    }
    Ok(())
}

pub fn catalog(on_application: impl FnMut(&Application) -> Result<(), ()>) -> Result<Catalog, ()> {
    let _apartment = Apartment::new()?;
    let mut collector = Collector {
        items: Vec::new(),
        seen: HashSet::new(),
        paths: HashSet::new(),
        on_application,
        truncated: false,
        delivery_failed: false,
    };
    let mut incomplete = false;
    let shortcuts = super::shortcuts::enumerate(|shortcut| {
        let item = shell_item(&shortcut.source_path);
        let args = if shortcut.arguments.is_empty() {
            Vec::new()
        } else {
            arguments(&format!("placeholder.exe {}", shortcut.arguments))
                .map(|mut values| {
                    values.remove(0);
                    values
                })
                .unwrap_or_else(|| vec![shortcut.arguments.clone()])
        };
        collector.add(
            shortcut.name,
            executable(&shortcut.target),
            args,
            &shortcut.source_path,
            item.as_ref(),
        )
    });
    incomplete |= shortcuts.is_err();
    if collector.delivery_failed {
        return Err(());
    }
    let indexed = super::search_index::enumerate(|indexed| {
        if let Some(shortcut) = super::shortcuts::read_indexed(&indexed.source_path) {
            let item = shell_item(&shortcut.source_path);
            let args = if shortcut.arguments.is_empty() {
                Vec::new()
            } else {
                arguments(&format!("placeholder.exe {}", shortcut.arguments))
                    .map(|mut values| {
                        values.remove(0);
                        values
                    })
                    .unwrap_or_else(|| vec![shortcut.arguments.clone()])
            };
            collector.add(
                shortcut.name,
                executable(&shortcut.target),
                args,
                &shortcut.source_path,
                item.as_ref(),
            )
        } else {
            let source = indexed.source_path.to_string_lossy();
            let item = shell_item(&source);
            let name = indexed
                .source_path
                .file_stem()
                .and_then(|value| value.to_str())
                .map(str::to_owned)
                .unwrap_or(indexed.name);
            collector.add(
                name,
                indexed.target.as_deref().and_then(executable),
                Vec::new(),
                &source,
                item.as_ref(),
            )
        }
    });
    incomplete |= indexed.is_err();
    if collector.delivery_failed {
        return Err(());
    }
    let shell = shell_applications(&mut |name, path, args, fallback, item| {
        collector.add(name, path, args, &fallback, Some(item))
    });
    incomplete |= shell.is_err();
    if collector.delivery_failed {
        return Err(());
    }
    let registrations = super::app_paths::enumerate(|registration| {
        let path = registration.path.and_then(|path| executable(&path));
        if path
            .as_ref()
            .is_some_and(|path| collector.paths.contains(&path.to_lowercase()))
        {
            return Ok(());
        }
        let item = path.as_deref().and_then(shell_item);
        let name = item
            .as_ref()
            .and_then(|item| property(item, &FILE_DESCRIPTION))
            .unwrap_or_else(|| display_name(&registration.filename));
        collector.add(
            name,
            path,
            Vec::new(),
            &registration.filename,
            item.as_ref(),
        )
    });
    incomplete |= registrations.is_err();
    if collector.delivery_failed {
        return Err(());
    }
    Ok(Catalog {
        items: collector.items,
        incomplete,
        truncated: collector.truncated,
    })
}

// Preserve existing array callers and executable-only rows. Modern callers use catalog().
pub fn installed(
    mut on_application: impl FnMut(&Application) -> Result<(), ()>,
) -> Result<Vec<Application>, ()> {
    let mut delivered = 0;
    let catalog = catalog(|row| {
        if row.path.is_empty() || delivered >= 4096 {
            Ok(())
        } else {
            delivered += 1;
            on_application(row)
        }
    })?;
    let mut result: Vec<_> = catalog
        .items
        .into_iter()
        .filter(|row| !row.path.is_empty())
        .take(4096)
        .collect();
    result.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(result)
}

fn display_name(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Application")
        .to_owned()
}
fn describe_one(path: String) -> Application {
    let item = shell_item(&path);
    let name = item
        .as_ref()
        .and_then(|item| property(item, &FILE_DESCRIPTION))
        .unwrap_or_else(|| display_name(&path));
    let icon = item.as_ref().and_then(icon);
    Application {
        id: identity(&name, &path, &[], ""),
        path,
        name,
        icon,
        launch_options: false,
    }
}
pub fn describe(paths: Vec<String>) -> Result<Vec<Application>, ()> {
    let _apartment = Apartment::new()?;
    Ok(paths.into_iter().map(describe_one).collect())
}

pub fn select(owner: usize) -> Result<Option<Application>, ()> {
    use windows_sys::Win32::UI::Controls::Dialogs::{
        CommDlgExtendedError, GetOpenFileNameW, OFN_EXPLORER, OFN_FILEMUSTEXIST, OFN_NOCHANGEDIR,
        OFN_PATHMUSTEXIST, OPENFILENAMEW,
    };
    let mut buffer = vec![0u16; 32768];
    let filter: Vec<u16> = "Applications (*.exe)\0*.exe\0\0".encode_utf16().collect();
    let mut options: OPENFILENAMEW = unsafe { std::mem::zeroed() };
    options.lStructSize = std::mem::size_of::<OPENFILENAMEW>() as u32;
    options.hwndOwner = owner as _;
    options.lpstrFilter = filter.as_ptr();
    options.lpstrFile = buffer.as_mut_ptr();
    options.nMaxFile = buffer.len() as u32;
    options.Flags = OFN_EXPLORER | OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;
    if unsafe { GetOpenFileNameW(&mut options) } == 0 {
        return if unsafe { CommDlgExtendedError() } == 0 {
            Ok(None)
        } else {
            Err(())
        };
    }
    let length = buffer
        .iter()
        .position(|character| *character == 0)
        .ok_or(())?;
    let path = String::from_utf16(&buffer[..length]).map_err(|_| ())?;
    if !super::model::valid_application(&path) {
        return Err(());
    }
    let _apartment = Apartment::new()?;
    Ok(Some(describe_one(path)))
}

#[cfg(test)]
mod catalog_tests {
    use super::*;

    #[test]
    fn package_provider_failure_marks_partial_discovery_without_repeating_lookup() {
        let mut cached = None;
        let mut incomplete = false;
        assert!(package_path(&mut cached, &mut incomplete, "Package!App", || Err(())).is_none());
        assert!(incomplete);
        assert!(package_path(&mut cached, &mut incomplete, "Other!App", || {
            panic!("A failed provider is read once per catalog request")
        }).is_none());
        assert!(incomplete);

        cached = None;
        incomplete = false;
        let expected = r"C:\Apps\StoreApp.exe";
        assert_eq!(package_path(&mut cached, &mut incomplete, "PACKAGE!APP", || {
            Ok(HashMap::from([("package!app".into(), expected.into())]))
        }).as_deref(), Some(expected));
        assert!(package_path(&mut cached, &mut incomplete, "Absent!App", || {
            panic!("Successful package metadata is cached too")
        }).is_none());
        assert!(!incomplete, "An absent app is not a failed provider");
    }

    #[test]
    fn quoted_launch_commands_keep_the_executable_separate_from_options() {
        let path = std::env::current_exe()
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        let (actual, options) = command(&format!(
            "\"{}\" --launch-product=league_of_legends --launch-patchline=live",
            path
        ))
        .unwrap();
        assert!(super::super::model::same_path(&actual, &path));
        assert_eq!(
            options,
            [
                "--launch-product=league_of_legends",
                "--launch-patchline=live"
            ]
        );
        for invalid in [
            "",
            "  ",
            "file:///C:/private.exe",
            "steam://rungameid/123",
            "\"C:\\Missing Catalog Fixture\\missing.exe\" --launch-product=game",
            "cmd.exe /c start game",
        ] {
            assert!(command(invalid).is_none());
        }
    }

    #[test]
    fn catalog_identity_keeps_same_launcher_games_and_unresolved_entries_distinct() {
        let path = r"C:\Riot Games\Riot Client\RiotClientServices.exe";
        let league = identity(
            "League of Legends",
            path,
            &["--launch-product=league_of_legends".into()],
            "first.lnk",
        );
        assert_eq!(
            league,
            identity(
                "LEAGUE OF LEGENDS",
                &path.to_lowercase(),
                &["--launch-product=league_of_legends".into()],
                "second.lnk"
            )
        );
        assert_ne!(
            league,
            identity("VALORANT", path, &["--launch-product=valorant".into()], "")
        );
        assert_ne!(
            league,
            identity(
                "League of Legends",
                path,
                &["--launch-product=other".into()],
                ""
            )
        );
        assert_ne!(
            identity("Game", "", &[], "first.url"),
            identity("Game", "", &[], "second.url")
        );
    }

    #[test]
    fn stream_failure_stops_collection_and_unresolved_rows_are_not_executable_rules() {
        let mut collector = Collector {
            items: Vec::new(),
            seen: HashSet::new(),
            paths: HashSet::new(),
            on_application: |_row: &Application| Err(()),
            truncated: false,
            delivery_failed: false,
        };
        assert!(
            collector
                .add("Game".into(), None, Vec::new(), "game.url", None)
                .is_err()
        );
        assert!(collector.delivery_failed);
        assert!(collector.items.is_empty());
        assert!(!super::super::model::valid_application(""));
    }

    #[test]
    #[ignore = "Explicit read-only current-PC catalog smoke; no program launch"]
    fn current_pc_catalog_smoke() {
        let mut progress = Vec::new();
        let catalog = catalog(|row| {
            progress.push(row.id.clone());
            Ok(())
        })
        .unwrap();
        assert!(!catalog.items.is_empty());
        assert_eq!(
            progress,
            catalog
                .items
                .iter()
                .map(|row| row.id.clone())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            progress.len(),
            progress.iter().collect::<HashSet<_>>().len()
        );
        let league = catalog.items.iter().find(|row| {
            let name = row.name.to_lowercase();
            name.contains("league of legends") || name.contains("리그 오브 레전드")
        });
        if std::env::var_os("DMELOPER_CATALOG_EXPECT_LEAGUE").is_some() {
            let league = league.expect("Owner's installed League shortcut must remain visible");
            assert!(super::super::model::same_path(
                &league.path,
                r"C:\Riot Games\Riot Client\RiotClientServices.exe"
            ));
            assert!(league.launch_options);
        }
        println!(
            "catalog_items={} resolved={} incomplete={} truncated={} league_found={}",
            catalog.items.len(),
            catalog
                .items
                .iter()
                .filter(|row| !row.path.is_empty())
                .count(),
            catalog.incomplete,
            catalog.truncated,
            league.is_some()
        );
    }
}
