//! Portable preset I/O and the operation-owned skin-library import journal.
//! Nested under skin_library so its existing validators and atomic writer remain authoritative.
use super::*;
use serde_json::{Map, Value};

const FORMAT: &str = "dmeloper.petpreset";
const FILE_LIMIT: usize = 4 * 1024 * 1024;
const JOURNAL_LIMIT: usize = 128 * 1024 * 1024;
const JOURNAL: &str = ".preset-import.json";

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PortablePreset {
    format: String,
    version: u32,
    name: String,
    settings: Value,
    skin: PortableSkin,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(
    tag = "mode",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum PortableSkin {
    Image {
        png_base64: String,
        model: SkinLibraryModel,
        #[serde(skip_serializing_if = "Option::is_none")]
        nickname: Option<String>,
    },
    Nickname {
        nickname: String,
    },
}

type TransferResult<T> = Result<T, String>;
fn log_transfer_io(operation: &'static str, error: &io::Error) {
    crate::diagnostics::warn(operation, &format!("IO_{:?}_OS_{}", error.kind(), error.raw_os_error().unwrap_or(0)));
}
fn transfer_error(_: impl std::fmt::Debug) -> String {
    "read".into()
}
fn library_error(_: impl std::fmt::Debug) -> String {
    "library".into()
}

fn keys(value: &Value, expected: &[&str]) -> bool {
    value.as_object().is_some_and(|map| {
        map.len() == expected.len() && expected.iter().all(|key| map.contains_key(*key))
    })
}
fn number(value: &Value, min: f64, max: f64) -> bool {
    value
        .as_f64()
        .is_some_and(|n| n.is_finite() && n >= min && n <= max)
}
fn color(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit())
    })
}

fn validate_settings(s: &Value) -> bool {
    if !keys(
        s,
        &["preset", "mirror", "opacity", "eyebrowAnimationEnabled"],
    ) || !s["mirror"].is_boolean()
        || !s["eyebrowAnimationEnabled"].is_boolean()
        || !number(&s["opacity"], 0.0, 100.0)
    {
        return false;
    }
    let p = &s["preset"];
    let ranges = [
        ("petRightArmBendPercent", 0.0, 400.0),
        ("petLeftArmBendPercent", 0.0, 400.0),
        ("petRightArmSpreadDegrees", -45.0, 45.0),
        ("petLeftArmSpreadDegrees", -45.0, 45.0),
        ("petHeadScalePercent", 25.0, 200.0),
        crate::settings_defaults::numeric_range("preset", "petRotationDegrees"),
        crate::settings_defaults::numeric_range("preset", "petDeskOffset"),
        ("deskHeightOffset", -1.0, 1.0),
        ("deskWidthOffset", -1.0, 1.0),
        ("deskDepthOffset", -1.0, 1.0),
        ("sceneRotationOffsetDegrees", -360.0, 360.0),
        ("cameraHorizontalOffset", -1.5, 1.5),
        ("cameraVerticalOffset", -1.5, 1.5),
        ("cameraZoomPercent", 25.0, 200.0),
        crate::settings_defaults::numeric_range("preset", "mouseBaseXOffset"),
        crate::settings_defaults::numeric_range("preset", "mouseBaseZOffset"),
        ("mouseScalePercent", 50.0, 200.0),
        crate::settings_defaults::numeric_range("preset", "keyboardBaseXOffset"),
        crate::settings_defaults::numeric_range("preset", "keyboardBaseZOffset"),
        ("keyboardScalePercent", 50.0, 200.0),
        ("autoViewportPaddingPixels", 0.0, 30.0),
    ];
    let colors = [
        "deskColor",
        "keyboardColor",
        "keyboardKeycapColor",
        "keyboardLegendColor",
        "keyboardPressedColor",
        "mouseColor",
        "mousePressedColor",
        "dmeloperPalmColor",
    ];
    let booleans = ["showDisplayArea", "autoViewportEnabled", "mouseEnabled", "deskTransparent"];
    let expected: Vec<_> = ranges
        .iter()
        .map(|(key, _, _)| *key)
        .chain(colors)
        .chain(booleans)
        .chain([
            "lighting",
            "manualViewportRect",
            "dmeloperEyebrows",
            "keyboardLegendLanguage",
        ])
        .collect();
    if !crate::lighting_settings::is_valid(&p["lighting"])
        || !keys(p, &expected)
        || !ranges
            .iter()
            .all(|(key, min, max)| number(&p[key], *min, *max))
        || !colors.iter().all(|key| color(&p[key]))
        || !booleans.iter().all(|key| p[key].is_boolean())
        || !matches!(p["keyboardLegendLanguage"].as_str(), Some("en" | "ko"))
        || p["autoViewportPaddingPixels"].as_f64().unwrap().fract() != 0.0
    {
        return false;
    }
    let rect = &p["manualViewportRect"];
    let limit = 9_007_199_254_740_991.0;
    if !keys(rect, &["x", "y", "width", "height"])
        || !number(&rect["x"], -limit, limit)
        || !number(&rect["y"], -limit, limit)
        || !["width", "height"].iter().all(|key| {
            number(&rect[key], 100.0, limit) && rect[key].as_f64().unwrap().fract() == 0.0
        })
    {
        return false;
    }
    let brows = &p["dmeloperEyebrows"];
    keys(
        brows,
        &[
            "enabled",
            "color",
            "centerOffsetPixels",
            "heightOffsetPixels",
            "spacingPixels",
            "widthPixels",
            "thicknessPixels",
            "depthPercent",
        ],
    ) && brows["enabled"].is_boolean()
        && color(&brows["color"])
        && [
            ("centerOffsetPixels", -1.5, 1.5),
            ("heightOffsetPixels", -3.0, 3.0),
            crate::settings_defaults::numeric_range("eyebrows", "spacingPixels"),
            crate::settings_defaults::numeric_range("eyebrows", "widthPixels"),
            crate::settings_defaults::numeric_range("eyebrows", "thicknessPixels"),
            ("depthPercent", 0.0, 200.0),
        ]
        .iter()
        .all(|(key, min, max)| number(&brows[key], *min, *max))
}

fn validate_document(bytes: &[u8]) -> TransferResult<PortablePreset> {
    if bytes.len() > FILE_LIMIT {
        return Err("tooLarge".into());
    }
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    let mut preset: PortablePreset = serde_json::from_slice(bytes).map_err(|_| "invalidFormat")?;
    if preset.format != FORMAT {
        return Err("invalidFormat".into());
    }
    if preset.version != 1 {
        return Err("unsupportedVersion".into());
    }
    validate_display_name(&preset.name).map_err(|_| "invalidFormat")?;
    if let Some(brows) = preset.settings.pointer_mut("/preset/dmeloperEyebrows").and_then(Value::as_object_mut) {
        brows.entry("depthPercent").or_insert(Value::from(100));
    }
    if let Some(settings) = preset.settings.get_mut("preset").and_then(Value::as_object_mut) {
        let defaults: Map<String, Value> = crate::settings_defaults::section("preset")
            .map_err(|_| "invalidSettings")?;
        for key in ["deskTransparent", "deskHeightOffset", "deskWidthOffset", "deskDepthOffset", "deskColor"] {
            // Missing width belongs to an older desk; factory/reset now uses 0.
            let value = if key == "deskWidthOffset" {
                Value::from(-1)
            } else {
                defaults.get(key).ok_or("invalidSettings")?.clone()
            };
            settings.entry(key).or_insert(value);
        }
    }
    if let Some(settings) = preset.settings.get_mut("preset") {
        crate::lighting_settings::migrate_preset(settings);
    }
    if !validate_settings(&preset.settings) {
        return Err("invalidSettings".into());
    }
    let nickname = match &preset.skin {
        PortableSkin::Image {
            png_base64,
            nickname,
            ..
        } => {
            let png = decode_base64(png_base64, RAW_PNG_LIMIT).map_err(|_| "invalidSkin")?;
            validate_png(png, AssetKind::Raw).map_err(|_| "invalidSkin")?;
            nickname.as_deref()
        }
        PortableSkin::Nickname { nickname } => Some(nickname.as_str()),
    };
    if nickname.is_some_and(|n| !is_valid_java_nickname(n)) {
        return Err("invalidNickname".into());
    }
    Ok(preset)
}

fn require_preference(window: &tauri::WebviewWindow) -> TransferResult<()> {
    if window.label() != "preference" {
        return Err("invalidFormat".into());
    }
    Ok(())
}

fn read_preset_file(path: &Path) -> TransferResult<String> {
    if !path.is_absolute()
        || !path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("petpreset"))
    {
        return Err("invalidFormat".into());
    }
    crate::state_safety::check_path(path).map_err(transfer_error)?;
    if fs::metadata(path).map_err(transfer_error)?.len() > FILE_LIMIT as u64 {
        return Err("tooLarge".into());
    }
    let bytes = read_regular_file(path, FILE_LIMIT).map_err(transfer_error)?;
    validate_document(&bytes)?;
    String::from_utf8(bytes).map_err(transfer_error)
}

#[tauri::command]
pub async fn read_pet_preset(
    window: tauri::WebviewWindow,
    file_path: String,
) -> TransferResult<String> {
    let result: TransferResult<String> = async {
        require_preference(&window)?;
        tauri::async_runtime::spawn_blocking(move || read_preset_file(Path::new(&file_path)))
            .await
            .map_err(transfer_error)?
    }.await;
    if let Err(error) = &result {
        crate::diagnostics::warn("preset_transfer.read", error);
    }
    result
}

fn write_verified(path: &Path, bytes: &[u8], limit: usize) -> TransferResult<()> {
    if bytes.len() > limit {
        return Err("tooLarge".into());
    }
    crate::state_safety::check_path(path).map_err(|_| "save")?;
    let temp = path.with_file_name(format!(".petpreset-{}.tmp", unique_file_suffix()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(|error| {
                log_transfer_io("preset_transfer.write", &error);
                "save"
            })?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| {
                log_transfer_io("preset_transfer.write", &error);
                "save"
            })?;
        drop(file);
        if read_regular_file(&temp, limit).map_err(|_| "save")? != bytes {
            return Err("save".into());
        }
        atomic_replace_path(&temp, path).map_err(|error| {
            log_transfer_io("preset_transfer.replace", &error);
            "save"
        })?;
        if read_regular_file(path, limit).map_err(|_| "save")? != bytes {
            return Err("save".into());
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn write_preset_file(path: &Path, bytes: &[u8]) -> TransferResult<()> {
    if !path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("petpreset"))
    {
        return Err("invalidFormat".into());
    }
    write_verified(path, bytes, FILE_LIMIT).map_err(|_| "export".into())
}

fn suggested_filename(name: &str) -> String {
    let stem: String = name
        .chars()
        .take(100)
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let stem = stem.trim().trim_end_matches('.');
    let reserved = stem.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(reserved.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (reserved.len() == 4
            && (reserved.starts_with("COM") || reserved.starts_with("LPT"))
            && reserved.as_bytes()[3].is_ascii_digit());
    format!(
        "{}{}.petpreset",
        if reserved { "_" } else { "" },
        if stem.is_empty() { "Preset" } else { stem }
    )
}

fn save_dialog(owner: isize, name: &str) -> TransferResult<Option<PathBuf>> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::UI::Controls::Dialogs::*;
    let mut path = vec![0u16; 32768];
    let suggested: Vec<u16> = suggested_filename(name).encode_utf16().collect();
    path[..suggested.len()].copy_from_slice(&suggested);
    let filter: Vec<u16> = "Pet preset (*.petpreset)\0*.petpreset\0\0"
        .encode_utf16()
        .collect();
    let extension: Vec<u16> = "petpreset\0".encode_utf16().collect();
    let mut options: OPENFILENAMEW = unsafe { std::mem::zeroed() };
    options.lStructSize = std::mem::size_of::<OPENFILENAMEW>() as u32;
    options.hwndOwner = owner as _;
    options.lpstrFile = path.as_mut_ptr();
    options.nMaxFile = path.len() as u32;
    options.lpstrFilter = filter.as_ptr();
    options.lpstrDefExt = extension.as_ptr();
    options.Flags = OFN_EXPLORER
        | OFN_OVERWRITEPROMPT
        | OFN_NOCHANGEDIR
        | OFN_PATHMUSTEXIST
        | OFN_DONTADDTORECENT;
    if unsafe { GetSaveFileNameW(&mut options) } == 0 {
        return if unsafe { CommDlgExtendedError() } == 0 {
            Ok(None)
        } else {
            Err("export".into())
        };
    }
    let length = path.iter().position(|unit| *unit == 0).ok_or("export")?;
    Ok(Some(PathBuf::from(std::ffi::OsString::from_wide(
        &path[..length],
    ))))
}

#[tauri::command]
pub async fn export_pet_preset(
    window: tauri::WebviewWindow,
    document: String,
) -> TransferResult<bool> {
    let result: TransferResult<bool> = async {
        require_preference(&window)?;
        let preset = validate_document(document.as_bytes())?;
        let owner = window.hwnd().map_err(|_| "export")?.0 as isize;
        tauri::async_runtime::spawn_blocking(move || {
            let Some(path) = save_dialog(owner, &preset.name)? else {
                return Ok(false);
            };
            write_preset_file(&path, document.as_bytes())?;
            Ok(true)
        })
        .await
        .map_err(|_| "export")?
    }.await;
    if let Err(error) = &result {
        crate::diagnostics::warn("preset_transfer.export", error);
    }
    result
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviousPresetState {
    pub collection: Value,
    pub snapshot: Value,
    pub visible: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreatedSkin {
    id: String,
    png: String,
    thumbnail: String,
    raw_existed: bool,
    thumbnail_existed: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresetImportJournal {
    version: u32,
    pub operation_id: String,
    preset_id: String,
    pub phase: String,
    pub previous: PreviousPresetState,
    skin_entry_id: String,
    created: Option<CreatedSkin>,
}

fn valid_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

fn journal(root: &Path) -> TransferResult<Option<PresetImportJournal>> {
    let path = root.join(JOURNAL);
    crate::state_safety::check_path(&path).map_err(|_| "recovery")?;
    if !path.try_exists().map_err(|_| "recovery")? {
        return Ok(None);
    }
    let record: PresetImportJournal =
        serde_json::from_slice(&read_regular_file(&path, JOURNAL_LIMIT).map_err(|_| "recovery")?)
            .map_err(|_| "recovery")?;
    if record.version != 1
        || !valid_id(&record.operation_id)
        || !valid_id(&record.preset_id)
        || !matches!(record.phase.as_str(), "prepared" | "committed")
        || validate_entry_id(&record.skin_entry_id).is_err()
        || record.created.as_ref().is_some_and(|c| {
            c.id != record.skin_entry_id
                || validate_hash(&c.png).is_err()
                || validate_hash(&c.thumbnail).is_err()
        })
    {
        return Err("recovery".into());
    }
    Ok(Some(record))
}

fn write_journal(root: &Path, record: &PresetImportJournal) -> TransferResult<()> {
    let bytes = serde_json::to_vec(record).map_err(|_| "recovery")?;
    write_verified(&root.join(JOURNAL), &bytes, JOURNAL_LIMIT).map_err(|_| "recovery".into())
}

pub(crate) fn has_pending_import(app: &tauri::AppHandle) -> TransferResult<bool> {
    let root = crate::data_paths::durable_root(app)
        .map_err(|_| "storage".to_string())?
        .join(LIBRARY_DIRECTORY);
    Ok(journal(&root)?.is_some_and(|record| record.phase == "prepared"))
}

fn recoverable_collection(current: &Value, record: &PresetImportJournal) -> bool {
    if *current == record.previous.collection {
        return true;
    }
    let Some(old) = record.previous.collection["entries"].as_array() else {
        return false;
    };
    let Some(next) = current["entries"].as_array() else {
        return false;
    };
    // Accept inactive additions and the previously applied import shape for recovery.
    if (current["activeId"] != record.previous.collection["activeId"]
        && current["activeId"] != record.preset_id)
        || next.len() != old.len() + 1
        || !old.iter().all(|entry| next.contains(entry))
        || next
            .iter()
            .filter(|entry| entry["id"] == record.preset_id)
            .count()
            != 1
    {
        return false;
    }
    let mut without_import = current.clone();
    without_import["entries"] = Value::Array(
        next.iter()
            .filter(|entry| entry["id"] != record.preset_id)
            .cloned()
            .collect(),
    );
    without_import["activeId"] = record.previous.collection["activeId"].clone();
    without_import == record.previous.collection
}

fn valid_rollback(previous: &PreviousPresetState, expected: &PreviousPresetState) -> bool {
    if previous.collection != expected.collection || previous.visible != expected.visible {
        return false;
    }
    let mut snapshot = previous.snapshot.clone();
    let old = &previous.snapshot["preset"]["manualViewportRect"];
    let new = &expected.snapshot["preset"]["manualViewportRect"];
    if old != new {
        let coordinate = |rect: &Value, key: &str| rect[key].as_f64();
        let Some((ow, oh, ox, oy, nw, nh, nx, ny)) = (|| {
            Some((
                coordinate(old, "width")?,
                coordinate(old, "height")?,
                coordinate(old, "x")?,
                coordinate(old, "y")?,
                coordinate(new, "width")?,
                coordinate(new, "height")?,
                coordinate(new, "x")?,
                coordinate(new, "y")?,
            ))
        })() else {
            return false;
        };
        // A new monitor can reduce the crop while preserving its center. No other
        // appearance/settings change may be excused as rollback normalization.
        if nw < 100.0
            || nh < 100.0
            || nw > ow
            || nh > oh
            || nw.fract() != 0.0
            || nh.fract() != 0.0
            || nx != ox + (ow - nw) / 2.0
            || ny != oy + (oh - nh) / 2.0
        {
            return false;
        }
        snapshot["preset"]["manualViewportRect"] = new.clone();
    }
    snapshot == expected.snapshot
}

fn matches_previous(block: &Value, previous: &PreviousPresetState) -> bool {
    let snapshot = &previous.snapshot;
    let appearance = snapshot["appearance"].as_object();
    block["presetCollection"] == previous.collection
        && block["window"]["visible"].as_bool() == Some(previous.visible)
        && block["window"]["opacity"] == snapshot["opacity"]
        && block["model"]["mirror"] == snapshot["mirror"]
        && block["model"]["eyebrowAnimationEnabled"] == snapshot["eyebrowAnimationEnabled"]
        && snapshot["preset"].as_object().is_some_and(|p| {
            !p.is_empty()
                && p.iter()
                    .all(|(k, v)| block["customization3d"]["preset"][k] == *v)
        })
        && appearance.is_some_and(|p| {
            !p.is_empty() && p.iter().all(|(k, v)| block["customization3d"][k] == *v)
        })
        && [
            "selectedModelId",
            "dmeloperSkinDataUrl",
            "minecraftSkinUsername",
            "activeSkinLibraryEntryId",
            "dmeloperSkinModel",
            "useDefaultDmeloperSkin",
        ]
        .iter()
        .all(|key| block["customization3d"][key] == snapshot["appearance"][key])
}

fn disk_block(app: &tauri::AppHandle) -> TransferResult<Value> {
    use tauri_plugin_pinia::ManagerExt;
    // Pinia owns the filename, including its debug-only .dev.json suffix.
    let path = app
        .pinia()
        .with_store("cat", |store| store.path())
        .map_err(transfer_error)?;
    crate::state_safety::check_path(&path).map_err(|_| "recovery")?;
    serde_json::from_slice(&read_regular_file(&path, JOURNAL_LIMIT).map_err(transfer_error)?)
        .map_err(transfer_error)
}

fn saved_block(app: &tauri::AppHandle) -> TransferResult<Value> {
    use tauri_plugin_pinia::ManagerExt;
    let saved = disk_block(app)?;
    let backend = serde_json::to_value(app.pinia().state("cat").map_err(transfer_error)?)
        .map_err(transfer_error)?;
    if backend != saved {
        return Err("save".into());
    }
    Ok(saved)
}

impl SkinLibraryService {
    pub(super) fn ensure_no_preset_import(&self) -> Result<(), LibraryError> {
        let root = self.root()?;
        if let Some(record) = journal(root).map_err(|_| LibraryError::new(LibraryErrorKind::Io))? {
            if record.phase != "committed" {
                return Err(LibraryError::new(LibraryErrorKind::Io));
            }
            fs::remove_file(root.join(JOURNAL))?;
        }
        Ok(())
    }

    fn prepare_import(
        &self,
        operation_id: String,
        preset_id: String,
        previous: PreviousPresetState,
        mut request: StoreSkinLibraryEntryRequest,
    ) -> TransferResult<SkinLibraryEntry> {
        self.ensure_no_preset_import().map_err(|_| "recovery")?;
        if !valid_id(&operation_id) || !valid_id(&preset_id) {
            return Err("invalidFormat".into());
        }
        let root = self.root().map_err(library_error)?;
        let png = validate_png(
            decode_base64(&request.png_base64, RAW_PNG_LIMIT).map_err(library_error)?,
            AssetKind::Raw,
        )
        .map_err(library_error)?;
        let entries = self.list().map_err(library_error)?;
        let matching = entries.iter().find(|entry| entry.png_sha256 == png.sha256);
        let (skin_entry_id, created) = if let Some(entry) = matching {
            (entry.id.clone(), None)
        } else {
            let requested = validate_store_request(request.clone()).map_err(library_error)?;
            if entries.iter().any(|entry| entry.id == requested.id) {
                request.source = SkinLibrarySource::Local;
                request.canonical_nickname = None;
                request.original_filename = Some(format!("preset-{}.png", png.sha256));
            }
            // A user's identically named local import is also never overwritten.
            for suffix in 2.. {
                let validated = validate_store_request(request.clone()).map_err(library_error)?;
                if !entries.iter().any(|entry| entry.id == validated.id) {
                    break;
                }
                request.original_filename = Some(format!("preset-{}-{suffix}.png", png.sha256));
            }
            let base = request.display_name.clone();
            for suffix in 2.. {
                if !entries
                    .iter()
                    .any(|entry| entry.display_name == request.display_name)
                {
                    break;
                }
                let ending = format!(" {suffix}");
                request.display_name = format!(
                    "{}{}",
                    base.chars().take(255 - ending.len()).collect::<String>(),
                    ending
                );
            }
            request.overwrite_existing = false;
            let validated = validate_store_request(request.clone()).map_err(library_error)?;
            (
                validated.id.clone(),
                Some(CreatedSkin {
                    id: validated.id,
                    png: png.sha256.clone(),
                    thumbnail: validated.thumbnail.sha256.clone(),
                    raw_existed: asset_path(root, RAW_DIRECTORY, &png.sha256)
                        .try_exists()
                        .map_err(transfer_error)?,
                    thumbnail_existed: asset_path(
                        root,
                        THUMBNAIL_DIRECTORY,
                        &validated.thumbnail.sha256,
                    )
                    .try_exists()
                    .map_err(transfer_error)?,
                }),
            )
        };
        ensure_library_directories(root).map_err(library_error)?;
        write_journal(
            root,
            &PresetImportJournal {
                version: 1,
                operation_id,
                preset_id,
                phase: "prepared".into(),
                previous,
                skin_entry_id,
                created,
            },
        )?;
        if let Some(entry) = matching {
            return Ok(entry.clone());
        }
        self.store_with_options(request, CATALOG_BYTE_LIMIT, false)
            .map_err(library_error)
    }

    fn finish_import(
        &self,
        operation_id: &str,
        commit: bool,
        expected: &PreviousPresetState,
        block: &Value,
    ) -> TransferResult<()> {
        let root = self.root().map_err(library_error)?;
        let mut record = journal(root)?.ok_or("recovery")?;
        if record.operation_id != operation_id {
            return Err("recovery".into());
        }
        if record.phase == "committed" {
            return if commit {
                Ok(())
            } else {
                Err("recovery".into())
            };
        }
        if !matches_previous(block, expected) {
            return Err("save".into());
        }
        if commit {
            let previous_entries = record.previous.collection["entries"]
                .as_array()
                .ok_or("recovery")?;
            let next_entries = expected.collection["entries"]
                .as_array()
                .ok_or("recovery")?;
            let target = next_entries
                .iter()
                .find(|e| e["id"] == record.preset_id)
                .ok_or("recovery")?;
            if expected.collection["activeId"] != record.previous.collection["activeId"]
                || next_entries.len() != previous_entries.len() + 1
                || !recoverable_collection(&expected.collection, &record)
                || expected.snapshot != record.previous.snapshot
                || expected.visible != record.previous.visible
                || target["snapshot"]["appearance"]["activeSkinLibraryEntryId"]
                    != record.skin_entry_id
            {
                return Err("recovery".into());
            }
            let skin = self.read(&record.skin_entry_id).map_err(library_error)?;
            let mut settings = target["snapshot"].clone();
            settings.as_object_mut().ok_or("recovery")?.remove("appearance");
            if !validate_settings(&settings)
                || target["snapshot"]["appearance"]["dmeloperSkinDataUrl"]
                    != format!("data:image/png;base64,{}", skin.png_base64)
            {
                return Err("recovery".into());
            }
            record.phase = "committed".into();
            // Retain the receipt until the next operation: an IPC reply can be lost after commit.
            write_journal(root, &record)?;
        } else {
            if !valid_rollback(&record.previous, expected) {
                return Err("recovery".into());
            }
            let _guard = self.lock().map_err(library_error)?;
            let mut catalog = load_catalog(root).map_err(library_error)?;
            if let Some(created) = &record.created {
                if let Some(entry) = catalog.entries.iter().find(|e| e.id == created.id) {
                    if entry.png_sha256 != created.png
                        || entry.thumbnail_sha256 != created.thumbnail
                    {
                        return Err("recovery".into());
                    }
                    catalog.entries.retain(|e| e.id != created.id);
                    write_catalog_atomic(root, &catalog).map_err(library_error)?;
                }
                for (directory, hash, existed) in [
                    (RAW_DIRECTORY, &created.png, created.raw_existed),
                    (
                        THUMBNAIL_DIRECTORY,
                        &created.thumbnail,
                        created.thumbnail_existed,
                    ),
                ] {
                    let referenced = catalog.entries.iter().any(|entry| {
                        if directory == RAW_DIRECTORY {
                            &entry.png_sha256 == hash
                        } else {
                            &entry.thumbnail_sha256 == hash
                        }
                    });
                    if !existed && !referenced {
                        let path = asset_path(root, directory, hash);
                        crate::state_safety::check_path(&path).map_err(|_| "recovery")?;
                        if path.try_exists().map_err(transfer_error)? {
                            fs::remove_file(path).map_err(|_| "recovery")?;
                        }
                    }
                }
            }
            fs::remove_file(root.join(JOURNAL)).map_err(|_| "recovery")?;
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn prepare_preset_import(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, SkinLibraryState>,
    operation_id: String,
    preset_id: String,
    previous: PreviousPresetState,
    request: StoreSkinLibraryEntryRequest,
) -> TransferResult<SkinLibraryEntry> {
    let result: TransferResult<SkinLibraryEntry> = async {
        require_preference(&window)?;
        let service = Arc::clone(&state.service);
        tauri::async_runtime::spawn_blocking(move || {
            let _guard = crate::state_safety::guard_write().map_err(|_| "recovery")?;
            if !matches_previous(&saved_block(&app)?, &previous)
                || previous.collection["entries"]
                    .as_array()
                    .is_none_or(|entries| entries.iter().any(|e| e["id"] == preset_id))
            {
                return Err("save".into());
            }
            service.prepare_import(operation_id, preset_id, previous, request)
        })
        .await
        .map_err(transfer_error)?
    }.await;
    if let Err(error) = &result {
        crate::diagnostics::warn("preset_transfer.import_prepare", error);
    }
    result
}

#[tauri::command]
pub async fn read_preset_import(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, SkinLibraryState>,
) -> TransferResult<Option<PresetImportJournal>> {
    let result: TransferResult<Option<PresetImportJournal>> = async {
        require_preference(&window)?;
        let service = Arc::clone(&state.service);
        tauri::async_runtime::spawn_blocking(move || {
            let _guard = crate::state_safety::guard_read()?;
            let record = journal(service.root().map_err(library_error)?)?;
            if let Some(record) = &record {
                if record.phase == "prepared"
                    && !recoverable_collection(&disk_block(&app)?["presetCollection"], record)
                {
                    return Err("recovery".into());
                }
            }
            Ok(record)
        })
        .await
        .map_err(transfer_error)?
    }.await;
    if let Err(error) = &result {
        crate::diagnostics::warn("preset_transfer.import_recovery_read", error);
    }
    result
}

#[tauri::command]
pub async fn finish_preset_import(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, SkinLibraryState>,
    operation_id: String,
    commit: bool,
    expected: PreviousPresetState,
) -> TransferResult<()> {
    let result: TransferResult<()> = async {
        require_preference(&window)?;
        let service = Arc::clone(&state.service);
        tauri::async_runtime::spawn_blocking(move || {
            let _guard = crate::state_safety::guard_write().map_err(|_| "recovery")?;
            service.finish_import(&operation_id, commit, &expected, &saved_block(&app)?)
        })
        .await
        .map_err(transfer_error)?
    }.await;
    if let Err(error) = &result {
        crate::diagnostics::warn("preset_transfer.import_finish", error);
    }
    result
}

#[cfg(test)]
#[path = "preset_transfer_tests.rs"]
mod tests;
