//! Failure-only diagnostics. One append-only file; no rotation, payloads or activity log.
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

use log::{Level, LevelFilter, Log, Metadata, Record};
use serde::{Deserialize, Serialize};
use tauri::{Manager, Runtime, plugin::TauriPlugin};

const LOG_FILE: &str = "DMeloper's Block Pet.log";
const REPEAT_INTERVAL: Duration = Duration::from_secs(60);
const MAX_KEYS: usize = 128;
const MAX_PER_MINUTE: usize = 60;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportSystemInfo {
    windows_edition: Option<String>,
    windows_release: Option<String>,
    windows_build: String,
    webview2_version: Option<String>,
}

fn support_registry_string(name: &str) -> Option<String> {
    use windows_sys::Win32::System::Registry::{
        HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RRF_SUBKEY_WOW6464KEY, RegGetValueW,
    };
    let key = crate::windows_process::wide("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion");
    let name = crate::windows_process::wide(name);
    let mut buffer = [0u16; 128];
    let mut bytes = std::mem::size_of_val(&buffer) as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            key.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY,
            std::ptr::null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut bytes,
        )
    };
    if status != 0 {
        return None;
    }
    support_decode_string(&buffer, bytes)
}

fn support_decode_string(buffer: &[u16], bytes: u32) -> Option<String> {
    let length = bytes as usize / 2;
    if bytes % 2 != 0 || length == 0 || length > buffer.len() {
        return None;
    }
    let value = &buffer[..length];
    let end = value.iter().position(|unit| *unit == 0)?;
    let text = String::from_utf16(&value[..end]).ok()?;
    // Only OS release/edition labels, never arbitrary registry text or identifiers.
    if text.is_empty()
        || !text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b" ._-".contains(&byte))
    {
        return None;
    }
    Some(text)
}

fn support_build(version: String, revision: Option<u32>) -> String {
    match revision {
        Some(revision)
            if version.split('.').count() == 3
                && version.split('.').all(|part| part.parse::<u32>().is_ok()) =>
        {
            format!("{version}.{revision}")
        }
        _ => version,
    }
}

fn support_authorize(label: &str) -> Result<(), String> {
    if label == "preference" {
        Ok(())
    } else {
        Err("SUPPORT_INFO_FORBIDDEN".into())
    }
}

fn log_directory_authorize(label: &str) -> Result<(), String> {
    if label == "preference" {
        Ok(())
    } else {
        Err("LOG_DIRECTORY_FORBIDDEN".into())
    }
}

fn ensure_log_directory(directory: PathBuf) -> Result<PathBuf, String> {
    crate::state_safety::check_path(&directory)?;
    fs::create_dir_all(&directory).map_err(|_| "LOG_DIRECTORY_CREATE_FAILED".to_string())?;
    Ok(directory)
}

/// Explicit Open Logs creates only the fixed log directory, never an empty log.
#[tauri::command]
pub fn prepare_log_directory(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<PathBuf, String> {
    log_directory_authorize(window.label())?;
    let directory = app
        .path()
        .app_log_dir()
        .map_err(|_| "LOG_DIRECTORY_UNAVAILABLE".to_string())?;
    ensure_log_directory(directory)
}

/// On-demand, fixed-field reads only; no log writes, shell, network or caller-supplied paths.
#[tauri::command]
pub fn support_system_info(window: tauri::WebviewWindow) -> Result<SupportSystemInfo, String> {
    support_authorize(window.label())?;
    Ok(SupportSystemInfo {
        windows_edition: support_registry_string("EditionID"),
        windows_release: support_registry_string("DisplayVersion"),
        windows_build: support_build(
            tauri_plugin_os::version().to_string(),
            crate::windows_process::windows_revision(),
        ),
        webview2_version: tauri::webview_version().ok(),
    })
}

pub fn warn(operation: &'static str, code: &str) {
    log::warn!(target: "diagnostics", "{operation} code={}", safe_code(code));
}

pub fn error(operation: &'static str, code: &str) {
    log::error!(target: "diagnostics", "{operation} code={}", safe_code(code));
}

fn identifier(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
}

fn safe_code(value: &str) -> &str {
    if identifier(value, 80) {
        value
    } else {
        "unclassified_failure"
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WebviewDiagnostic {
    operation: String,
    code: String,
    source: String,
    location: Option<String>,
}

fn safe_location(value: &str) -> bool {
    value.len() <= 180
        && (value.starts_with("src/") || value.starts_with("assets/"))
        && !value.contains("..")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_./-:".contains(&byte))
}

fn classified_message(record: &Record<'_>) -> String {
    let message = record.args().to_string();
    if record.target().starts_with("webview") {
        if message.len() <= 1024 {
            if let Ok(value) = serde_json::from_str::<WebviewDiagnostic>(&message) {
                if identifier(&value.operation, 96)
                    && identifier(&value.code, 80)
                    && matches!(value.source.as_str(), "main" | "preference" | "bootstrap")
                {
                    let location = value.location.filter(|location| safe_location(location));
                    return format!(
                        "source={} operation={} code={}{}",
                        value.source,
                        value.operation,
                        value.code,
                        location
                            .map(|location| format!(" at={location}"))
                            .unwrap_or_default()
                    );
                }
            }
        }
        // Legacy or malformed log calls must not disclose serialized settings or stack URLs.
        return "source=webview operation=diagnostic.invalid_record code=unclassified_failure"
            .into();
    }
    if record.target() == "diagnostics" {
        if let Some((operation, code)) = message.split_once(" code=") {
            if identifier(operation.trim_start_matches("operation="), 96) {
                return format!(
                    "source=native operation={} code={}",
                    operation.trim_start_matches("operation="),
                    safe_code(code)
                );
            }
        }
    }
    // Dependency errors can contain URLs, filesystem paths and data. Retain their
    // module/line and a failure category, never the raw formatted message or target URL.
    let module = record.module_path().unwrap_or(record.target());
    let module = if module.len() <= 120
        && module
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_:.-".contains(&byte))
    {
        module
    } else {
        "dependency"
    };
    let lower = message
        .chars()
        .take(2048)
        .collect::<String>()
        .to_ascii_lowercase();
    let code = if lower.contains("permission") || lower.contains("access is denied") {
        "permission_denied"
    } else if lower.contains("timeout") || lower.contains("timed out") {
        "timeout"
    } else if lower.contains("not found") {
        "not_found"
    } else if lower.contains("network") || lower.contains("connection") {
        "network_failure"
    } else {
        "unclassified_failure"
    };
    format!(
        "source=native operation={module} code={code} line={}",
        record.line().unwrap_or(0)
    )
}

struct Repeat {
    last: Instant,
    omitted: u64,
}
struct RateLimit {
    entries: HashMap<String, Repeat>,
    interval_start: Instant,
    written: [usize; 2],
    omitted: u64,
}
impl RateLimit {
    fn new(now: Instant) -> Self {
        Self {
            entries: HashMap::new(),
            interval_start: now,
            written: [0; 2],
            omitted: 0,
        }
    }
    fn admit(&mut self, key: &str, now: Instant) -> Option<(u64, u64)> {
        if now.duration_since(self.interval_start) >= REPEAT_INTERVAL {
            self.interval_start = now;
            self.written = [0; 2];
        }
        if let Some(previous) = self.entries.get_mut(key) {
            if now.duration_since(previous.last) < REPEAT_INTERVAL {
                previous.omitted = previous.omitted.saturating_add(1);
                return None;
            }
        }
        let severity = usize::from(key.starts_with("ERROR "));
        let panic = key.starts_with("ERROR source=native operation=application.panic ");
        if self.written[severity] >= MAX_PER_MINUTE && !panic {
            self.omitted = self.omitted.saturating_add(1);
            return None;
        }
        let repeated = self
            .entries
            .get(key)
            .map(|entry| entry.omitted)
            .unwrap_or(0);
        if self.entries.len() >= MAX_KEYS && !self.entries.contains_key(key) {
            if let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.last)
                .map(|(key, _)| key.clone())
            {
                self.entries.remove(&oldest);
            }
        }
        self.entries.insert(
            key.into(),
            Repeat {
                last: now,
                omitted: 0,
            },
        );
        self.written[severity] += 1;
        Some((repeated, std::mem::take(&mut self.omitted)))
    }
}

struct FailureLogger {
    path: PathBuf,
    rate: Mutex<RateLimit>,
}
impl FailureLogger {
    fn new(root: &Path) -> Self {
        Self {
            path: root.join(LOG_FILE),
            rate: Mutex::new(RateLimit::new(Instant::now())),
        }
    }
    fn record_at(&self, record: &Record<'_>, now: Instant) -> io::Result<()> {
        if !self.enabled(record.metadata()) {
            return Ok(());
        }
        let message = classified_message(record);
        let mut rate = self.rate.lock().unwrap_or_else(|error| error.into_inner());
        let key = format!("{} {message}", record.level());
        let Some((repeated, omitted)) = rate.admit(&key, now) else {
            return Ok(());
        };
        let time = tauri_plugin_log::TimezoneStrategy::UseLocal.get_now();
        let profile = if tauri::is_dev() {
            "development"
        } else {
            "packaged"
        };
        let line = format!(
            "[{time}][{}][v={}][{profile}][pid={}] {message} repeats_suppressed={repeated} flood_suppressed={omitted}\n",
            record.level(),
            env!("CARGO_PKG_VERSION"),
            std::process::id()
        );
        // Opening per admitted failure avoids retained handles and always appends across
        // restarts. Normal operation does not even create an empty file. No rename/delete.
        let result = (|| {
            fs::create_dir_all(self.path.parent().unwrap())?;
            let mut file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.path)?;
            file.write_all(line.as_bytes())?;
            file.flush()
        })();
        if result.is_err() {
            // Permit a later failure to retry after storage recovers; never log recursively.
            rate.entries.remove(&key);
        }
        result
    }
}
impl Log for FailureLogger {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        metadata.level() <= Level::Warn
    }
    fn log(&self, record: &Record<'_>) {
        let _ = self.record_at(record, Instant::now());
    }
    fn flush(&self) {} // Every admitted record opens, writes and flushes its own file.
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("diagnostics")
        .setup(|app, _| {
            let logger = FailureLogger::new(&app.path().app_log_dir()?);
            tauri_plugin_log::attach_logger(LevelFilter::Warn, Box::new(logger))?;
            let previous = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |info| {
                // Panic payloads may contain paths/data; record the source coordinate only.
                let code = info
                    .location()
                    .map(|location| {
                        let file = location
                            .file()
                            .rsplit(['/', '\\'])
                            .next()
                            .unwrap_or("source");
                        let file = if identifier(file, 48) { file } else { "source" };
                        format!("{file}_line_{}", location.line())
                    })
                    .unwrap_or_else(|| "location_unavailable".into());
                error("application.panic", &code);
                previous(info);
            }));
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn support_build_keeps_revision_and_does_not_invent_missing_information() {
        assert_eq!(
            support_build("10.0.26100".into(), Some(1234)),
            "10.0.26100.1234"
        );
        assert_eq!(support_build("10.0.26100".into(), None), "10.0.26100");
        assert_eq!(support_build("Unknown".into(), Some(1234)), "Unknown");
        assert_eq!(support_build("10.0.26100".into(), Some(0)), "10.0.26100.0");
    }

    #[test]
    fn support_registry_decoding_is_bounded_and_rejects_malformed_text() {
        let value: Vec<u16> = "24H2\0".encode_utf16().collect();
        assert_eq!(support_decode_string(&value, 10).as_deref(), Some("24H2"));
        assert!(support_decode_string(&value, 11).is_none());
        assert!(support_decode_string(&value, 12).is_none());
        assert!(support_decode_string(&value, 8).is_none());
        assert!(support_decode_string(&[0xd800, 0], 4).is_none());
        let path: Vec<u16> = "C:\\Users\\private\0".encode_utf16().collect();
        assert!(support_decode_string(&path, (path.len() * 2) as u32).is_none());
    }

    #[test]
    fn support_info_is_preference_only() {
        assert!(support_authorize("preference").is_ok());
        for label in ["main", "broadcast", "", "preference-other"] {
            assert!(support_authorize(label).is_err());
        }
    }

    #[test]
    fn log_directory_preparation_is_preference_only() {
        assert!(log_directory_authorize("preference").is_ok());
        for label in ["main", "broadcast", "", "preference-other"] {
            assert_eq!(
                log_directory_authorize(label).unwrap_err(),
                "LOG_DIRECTORY_FORBIDDEN"
            );
        }
    }

    #[test]
    fn explicit_log_open_creates_only_directory_and_preserves_existing_history() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("한글 😶 profile").join("logs");
        assert!(!directory.exists());
        assert_eq!(ensure_log_directory(directory.clone()).unwrap(), directory);
        assert!(directory.is_dir());
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 0);
        let retained = b"retained diagnostic evidence\n";
        fs::write(directory.join(LOG_FILE), retained).unwrap();
        ensure_log_directory(directory.clone()).unwrap();
        assert_eq!(fs::read(directory.join(LOG_FILE)).unwrap(), retained);
        assert_eq!(fs::read_dir(directory).unwrap().count(), 1);
    }

    #[test]
    fn log_directory_creation_failure_preserves_the_blocking_file() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("logs");
        fs::write(&directory, b"unrelated existing file").unwrap();
        assert_eq!(
            ensure_log_directory(directory.clone()).unwrap_err(),
            "LOG_DIRECTORY_CREATE_FAILED"
        );
        assert_eq!(fs::read(directory).unwrap(), b"unrelated existing file");
    }

    #[test]
    fn first_log_open_can_precede_directory_creation() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("new-profile").join("logs");
        let logger = FailureLogger::new(&directory);
        logger
            .record_at(
                &Record::builder()
                    .level(Level::Info)
                    .args(format_args!("normal activity"))
                    .build(),
                Instant::now(),
            )
            .unwrap();
        assert_eq!(
            fs::read_dir(&directory).unwrap_err().kind(),
            io::ErrorKind::NotFound
        );
        logger
            .record_at(
                &Record::builder()
                    .level(Level::Error)
                    .target("diagnostics")
                    .args(format_args!("about.open_logs code=unclassified_failure"))
                    .build(),
                Instant::now(),
            )
            .unwrap();
        assert!(directory.is_dir());
        assert!(directory.join(LOG_FILE).is_file());
    }

    #[test]
    fn success_is_silent_and_existing_large_file_survives_restart_without_rotation() {
        let root = tempfile::tempdir().unwrap();
        let now = Instant::now();
        let logger = FailureLogger::new(root.path());
        for level in [Level::Trace, Level::Debug, Level::Info] {
            logger
                .record_at(
                    &Record::builder()
                        .level(level)
                        .args(format_args!("normal activity"))
                        .build(),
                    now,
                )
                .unwrap();
        }
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
        let retained = "original evidence\n".repeat(4000);
        fs::write(root.path().join(LOG_FILE), &retained).unwrap();
        for _ in 0..2 {
            FailureLogger::new(root.path())
                .record_at(
                    &Record::builder()
                        .level(Level::Warn)
                        .target("diagnostics")
                        .args(format_args!("skin.fetch code=network_failure"))
                        .build(),
                    Instant::now(),
                )
                .unwrap();
        }
        let contents = fs::read_to_string(root.path().join(LOG_FILE)).unwrap();
        assert!(contents.starts_with(&retained));
        let profile = if tauri::is_dev() { "development" } else { "packaged" };
        assert_eq!(contents.matches(&format!("[{profile}][pid=")).count(), 2);
        let other_profile = if tauri::is_dev() { "packaged" } else { "development" };
        assert!(!contents.contains(&format!("[{other_profile}][pid=")));
        assert_eq!(contents.matches("skin.fetch").count(), 2);
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    }

    #[test]
    fn repeats_and_flood_are_bounded_without_normal_summary_records() {
        let now = Instant::now();
        let mut limit = RateLimit::new(now);
        assert_eq!(limit.admit("a", now), Some((0, 0)));
        for _ in 0..10000 {
            assert_eq!(limit.admit("a", now), None);
        }
        for i in 1..MAX_PER_MINUTE {
            assert!(limit.admit(&format!("{i}"), now).is_some());
        }
        assert_eq!(limit.admit("overflow", now), None);
        assert_eq!(limit.admit("ERROR first_failure", now), Some((0, 1)));
        for i in 1..MAX_PER_MINUTE {
            assert!(limit.admit(&format!("ERROR {i}"), now).is_some());
        }
        assert!(
            limit
                .admit(
                    "ERROR source=native operation=application.panic code=line_1",
                    now
                )
                .is_some()
        );
        assert_eq!(limit.admit("a", now + REPEAT_INTERVAL), Some((10000, 0)));
        for i in 0..400 {
            limit.admit(&format!("new{i}"), now + REPEAT_INTERVAL * (i + 2));
        }
        assert!(limit.entries.len() <= MAX_KEYS);
    }

    #[test]
    fn unsafe_payloads_and_raw_stack_locations_never_reach_disk() {
        let root = tempfile::tempdir().unwrap();
        let logger = FailureLogger::new(root.path());
        let message = r#"{"operation":"preset.import","code":"PRESET_INVALID","source":"preference","location":"src/services/presetTransfer.ts:12:3"}"#;
        logger
            .record_at(
                &Record::builder()
                    .level(Level::Error)
                    .target("webview:http://127.0.0.1/secret-token")
                    .args(format_args!("{message}"))
                    .build(),
                Instant::now(),
            )
            .unwrap();
        logger
            .record_at(
                &Record::builder()
                    .level(Level::Warn)
                    .target("diagnostics")
                    .args(format_args!(
                        "skin.read code=C:\\Users\\private-user\\skin.png"
                    ))
                    .build(),
                Instant::now(),
            )
            .unwrap();
        logger
            .record_at(
                &Record::builder()
                    .level(Level::Error)
                    .target("webview")
                    .args(format_args!("user skin nickname secret-token"))
                    .build(),
                Instant::now(),
            )
            .unwrap();
        let contents = fs::read_to_string(root.path().join(LOG_FILE)).unwrap();
        assert!(contents.contains("operation=preset.import code=PRESET_INVALID"));
        assert!(contents.contains("at=src/services/presetTransfer.ts:12:3"));
        for secret in [
            "secret-token",
            "private-user",
            "skin.png",
            "nickname",
            "127.0.0.1",
        ] {
            assert!(!contents.contains(secret));
        }
    }
}
