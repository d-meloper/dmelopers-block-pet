//! Transient foreground suppression; never writes user settings or pet visibility.
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const SAMPLE_MS: u64 = 500;

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub enabled: bool,
    pub applications: Vec<String>,
}

pub(super) fn valid_application(path: &str) -> bool {
    if path.encode_utf16().count() > 32767
        || !path.to_ascii_lowercase().ends_with(".exe")
        || path
            .chars()
            .any(|character| character < ' ' || "<>\"|?*/".contains(character))
    {
        return false;
    }
    let bytes = path.as_bytes();
    let drive = bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && &bytes[1..3] == b":\\";
    let unc = path.starts_with("\\\\");
    if !drive && !unc {
        return false;
    }
    let segments: Vec<_> = path[if drive { 3 } else { 2 }..].split('\\').collect();
    segments.len() >= if unc { 3 } else { 1 }
        && segments.iter().all(|segment| {
            !segment.is_empty() && !segment.contains(':') && !segment.ends_with(['.', ' '])
        })
}

impl Config {
    pub fn read(raw: Value) -> Option<Self> {
        let config: Self = serde_json::from_value(raw).ok()?;
        if config.applications.len() > 128 {
            return None;
        }
        if !config
            .applications
            .iter()
            .all(|path| valid_application(path))
        {
            return None;
        }
        Some(config)
    }
    pub fn active(&self) -> bool {
        self.enabled && !self.applications.is_empty()
    }
    pub fn application(&self, path: &str) -> Option<Rule> {
        self.applications
            .iter()
            .position(|target| same_path(target, path))
            .map(|index| Rule {
                kind: RuleKind::Application,
                index,
            })
    }
}

pub fn same_path(left: &str, right: &str) -> bool {
    let left = canonical(left);
    let right = canonical(right);
    same_canonical_path(&left, &right)
}

fn canonical(path: &str) -> Vec<u16> {
    path.replace('/', "\\")
        .trim_start_matches(r"\\?\")
        .encode_utf16()
        .collect()
}

fn same_canonical_path(left: &[u16], right: &[u16]) -> bool {
    unsafe {
        windows_sys::Win32::Globalization::CompareStringOrdinal(
            left.as_ptr(),
            left.len() as i32,
            right.as_ptr(),
            right.len() as i32,
            1,
        ) == windows_sys::Win32::Globalization::CSTR_EQUAL
    }
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RuleKind {
    Application,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
pub struct Rule {
    pub kind: RuleKind,
    pub index: usize,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Off,
    Empty,
    Observing,
    Hidden,
    Bypassed,
    Unavailable,
    Invalid,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub revision: u64,
    pub sequence: u64,
    pub visit: u64,
    pub ready: bool,
    pub suppressed: bool,
    pub matched_rule: Option<Rule>,
    pub state: Phase,
}

pub enum Observation {
    Own,
    Outside,
    Match(Rule),
    Unavailable,
}

pub struct Model {
    pub config: Option<Config>,
    pub status: Status,
    visit_rule: Option<Rule>,
    bypassed: bool,
    outside_since: Option<u64>,
    desktop_visible: bool,
    application_paths: Vec<Vec<u16>>,
}

impl Default for Model {
    fn default() -> Self {
        Self {
            config: Some(Config::default()),
            status: Status {
                revision: 0,
                sequence: 0,
                visit: 0,
                ready: true,
                suppressed: false,
                matched_rule: None,
                state: Phase::Off,
            },
            visit_rule: None,
            bypassed: false,
            outside_since: None,
            desktop_visible: true,
            application_paths: Vec::new(),
        }
    }
}

impl Model {
    pub fn active(&self) -> bool {
        self.desktop_visible && self.config.as_ref().is_some_and(Config::active)
    }

    pub fn application(&self, path: &str) -> Option<Rule> {
        let path = canonical(path);
        self.application_paths
            .iter()
            .position(|target| same_canonical_path(target, &path))
            .map(|index| Rule {
                kind: RuleKind::Application,
                index,
            })
    }

    pub fn set_desktop_visible(&mut self, visible: bool) -> bool {
        if self.desktop_visible == visible {
            return false;
        }
        self.desktop_visible = visible;
        // An unobserved interval cannot prove a stable exit. Keep the visit and
        // manual-show exception, but release its suppression while parked.
        self.outside_since = None;
        self.status.suppressed = false;
        self.status.ready = !self.active();
        self.status.state = match &self.config {
            None => Phase::Invalid,
            Some(config) if !config.enabled => Phase::Off,
            Some(config) if !config.active() => Phase::Empty,
            _ => Phase::Observing,
        };
        self.status.sequence += 1;
        true
    }

    pub fn configure(&mut self, config: Option<Config>) -> bool {
        if self.config == config && self.status.revision != 0 {
            return false;
        }
        self.config = config;
        self.application_paths = self
            .config
            .as_ref()
            .map(|config| {
                config
                    .applications
                    .iter()
                    .map(|path| canonical(path))
                    .collect()
            })
            .unwrap_or_default();
        self.status.revision += 1;
        self.visit_rule = None;
        self.bypassed = false;
        self.outside_since = None;
        self.status.suppressed = false;
        self.status.matched_rule = None;
        self.status.ready = !self.active();
        self.status.state = match &self.config {
            None => Phase::Invalid,
            Some(config) if !config.enabled => Phase::Off,
            Some(config) if !config.active() => Phase::Empty,
            _ => Phase::Observing,
        };
        self.status.sequence += 1;
        true
    }

    pub fn observe(&mut self, observation: Observation, now: u64) -> bool {
        if !self.active() {
            return false;
        }
        let previous = self.status.clone();
        self.status.ready = true;
        match observation {
            Observation::Match(rule) => {
                self.outside_since = None;
                if self.visit_rule != Some(rule) {
                    self.visit_rule = Some(rule);
                    self.status.visit += 1;
                    self.bypassed = false;
                }
                self.status.matched_rule = Some(rule);
                self.status.suppressed = !self.bypassed;
                self.status.state = if self.bypassed {
                    Phase::Bypassed
                } else {
                    Phase::Hidden
                };
            }
            Observation::Outside => {
                let since = *self.outside_since.get_or_insert(now);
                if now.saturating_sub(since) >= SAMPLE_MS {
                    self.visit_rule = None;
                    self.bypassed = false;
                    self.status.suppressed = false;
                    self.status.matched_rule = None;
                    self.status.state = Phase::Observing;
                }
            }
            Observation::Own => {
                // Own menus/preferences may temporarily cover a target application. They
                // release suppression without ending its manual-show exception.
                self.outside_since = None;
                self.status.suppressed = false;
                self.status.matched_rule = self.visit_rule;
                self.status.state = if self.bypassed {
                    Phase::Bypassed
                } else {
                    Phase::Observing
                };
            }
            Observation::Unavailable => {
                self.outside_since = None;
                self.status.suppressed = false;
                self.status.matched_rule = self.visit_rule;
                self.status.state = Phase::Unavailable;
            }
        }
        if previous != self.status {
            self.status.sequence += 1;
            return true;
        }
        false
    }

    pub fn show_current_visit(&mut self, revision: u64, visit: u64) -> bool {
        if self.status.revision != revision
            || self.status.visit != visit
            || self.visit_rule.is_none()
        {
            return false;
        }
        let previous = self.status.clone();
        self.bypassed = true;
        self.status.suppressed = false;
        self.status.state = Phase::Bypassed;
        if previous != self.status {
            self.status.sequence += 1;
            return true;
        }
        false
    }
}
