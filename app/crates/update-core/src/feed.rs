use base64::{Engine, engine::general_purpose::STANDARD};
use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use std::{io::Read, path::Path};

use super::{UpdateError, fail};

pub const PRODUCT: &str = "com.dmeloper.blockpet3d";
pub const OFFICIAL_REPOSITORY: &str = "d-meloper/dmelopers-3d-block-pet";
pub const TEST_REPOSITORY: &str = "oup030416/dmelopers-3d-block-pet-test";
#[cfg(not(feature = "test-repository"))]
pub const REPOSITORY: &str = OFFICIAL_REPOSITORY;
#[cfg(feature = "test-repository")]
pub const REPOSITORY: &str = TEST_REPOSITORY;
#[cfg(not(feature = "test-repository"))]
pub const UPDATE_DEFAULT_MARKER: &str = "DMELoper_UPDATE_DEFAULT_OFFICIAL";
#[cfg(feature = "test-repository")]
pub const UPDATE_DEFAULT_MARKER: &str = "DMELoper_UPDATE_DEFAULT_TEST";
#[cfg(all(feature = "test-repository", feature = "private-update-qa"))]
compile_error!("test-repository and private-update-qa are separate trust and transport profiles");
pub const PLATFORM: &str = "windows-x86_64";
pub const MAX_INSTALLER_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_METADATA_BYTES: u64 = 128 * 1024;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Trust {
    pub schema_version: u32,
    pub repository: String,
    pub repository_id: Option<u64>,
    pub public_key: Option<String>,
}

impl Trust {
    pub fn embedded() -> Result<Self, UpdateError> {
        Self::for_repository(REPOSITORY)
    }

    /// Only these two compiled trust records can authenticate an update. The
    /// editable source selector never supplies a key, numeric ID, or feed URL.
    pub fn for_repository(repository: &str) -> Result<Self, UpdateError> {
        std::hint::black_box(UPDATE_DEFAULT_MARKER);
        #[cfg(feature = "private-update-qa")]
        let trust: Self = serde_json::from_str(include_str!(concat!(
            env!("OUT_DIR"),
            "/private-trust.json"
        )))
        .map_err(|_| fail("PRIVATE_QA_FIXTURE_INVALID"))?;
        #[cfg(not(feature = "private-update-qa"))]
        let trust: Self = {
            let bytes = match repository {
                OFFICIAL_REPOSITORY => include_str!("../../../src-tauri/update-trust.json"),
                TEST_REPOSITORY => include_str!("../../../src-tauri/update-trust.test.json"),
                _ => return Err(fail("UPDATE_SOURCE_INVALID")),
            };
            serde_json::from_str(bytes).map_err(|_| fail("TRUST_NOT_CONFIGURED"))?
        };
        if trust.repository != repository {
            return Err(fail("TRUST_NOT_CONFIGURED"));
        }
        trust.key()?;
        Ok(trust)
    }

    fn key(&self) -> Result<PublicKey, UpdateError> {
        if self.schema_version != 1
            || !matches!(
                self.repository.as_str(),
                OFFICIAL_REPOSITORY | TEST_REPOSITORY
            )
            || self.repository_id.unwrap_or(0) == 0
        {
            return Err(fail("TRUST_NOT_CONFIGURED"));
        }
        let encoded = self
            .public_key
            .as_deref()
            .ok_or_else(|| fail("TRUST_NOT_CONFIGURED"))?;
        let bytes = STANDARD
            .decode(encoded.trim())
            .map_err(|_| fail("TRUST_NOT_CONFIGURED"))?;
        let text = std::str::from_utf8(&bytes).map_err(|_| fail("TRUST_NOT_CONFIGURED"))?;
        PublicKey::decode(text).map_err(|_| fail("TRUST_NOT_CONFIGURED"))
    }

    pub fn verify(&self, message: &[u8], signature: &str) -> Result<(), UpdateError> {
        let bytes = STANDARD
            .decode(signature.trim())
            .map_err(|_| fail("SIGNATURE_INVALID"))?;
        let text = std::str::from_utf8(&bytes).map_err(|_| fail("SIGNATURE_INVALID"))?;
        let signature = Signature::decode(text).map_err(|_| fail("SIGNATURE_INVALID"))?;
        self.key()?
            .verify(message, &signature, false)
            .map_err(|_| fail("SIGNATURE_INVALID"))
    }

    pub fn verify_file(&self, path: &Path, signature: &str) -> Result<(), UpdateError> {
        let bytes = STANDARD
            .decode(signature.trim())
            .map_err(|_| fail("SIGNATURE_INVALID"))?;
        let text = std::str::from_utf8(&bytes).map_err(|_| fail("SIGNATURE_INVALID"))?;
        let signature = Signature::decode(text).map_err(|_| fail("SIGNATURE_INVALID"))?;
        let key = self.key()?;
        let mut verifier = key
            .verify_stream(&signature)
            .map_err(|_| fail("SIGNATURE_INVALID"))?;
        let mut file = std::fs::File::open(path)?;
        let mut buffer = [0; 65536];
        loop {
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            verifier.update(&buffer[..count]);
        }
        verifier.finalize().map_err(|_| fail("SIGNATURE_INVALID"))
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Asset {
    pub name: String,
    pub size: u64,
    pub sha256: String,
    pub signature: String,
    pub installed_files: std::collections::BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DataSchema {
    pub min: u32,
    pub max: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallerWorker {
    pub path: String,
    pub sha256: String,
    pub size: u64,
    pub protocol_version: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MsiIdentity {
    pub name: String,
    pub sha256: String,
    pub size: u64,
    pub product_code: String,
    pub upgrade_code: String,
    pub package_code: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallerProtocol {
    pub format: String,
    pub protocol_version: u32,
    pub worker: InstallerWorker,
    #[serde(deserialize_with = "required_msi")]
    pub msi: Option<MsiIdentity>,
}

fn required_msi<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<MsiIdentity>, D::Error> {
    Option::<MsiIdentity>::deserialize(deserializer)
}

fn provided_installer<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<InstallerProtocol>, D::Error> {
    // A v1 feed must omit the field, not acquire a newly accepted `null` field.
    InstallerProtocol::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Feed {
    #[serde(skip)]
    pub authenticated_bytes: Vec<u8>,
    #[serde(skip)]
    pub authenticated_signature: String,
    pub schema_version: u32,
    pub repository: String,
    pub repository_id: u64,
    pub product: String,
    pub channel: String,
    pub platform: String,
    pub version: String,
    pub tag: String,
    pub asset: Asset,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "provided_installer"
    )]
    pub installer: Option<InstallerProtocol>,
    pub min_updater_schema: u32,
    pub data_schema: DataSchema,
    pub withdrawn: bool,
    pub published_at: String,
}

pub fn version(value: &str) -> Result<[u64; 3], UpdateError> {
    let parts: Vec<_> = value.split('.').collect();
    if parts.len() != 3 {
        return Err(fail("METADATA_INVALID"));
    }
    let mut parsed = [0; 3];
    for (index, part) in parts.iter().enumerate() {
        if part.is_empty()
            || (part.len() > 1 && part.starts_with('0'))
            || !part.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(fail("METADATA_INVALID"));
        }
        parsed[index] = part.parse().map_err(|_| fail("METADATA_INVALID"))?;
    }
    Ok(parsed)
}

pub fn asset_name(version: &str) -> String {
    format!("dmelopers-3d-block-pet_{version}_x64-setup.exe")
}

impl Feed {
    pub fn parse(bytes: &[u8], signature: &str, trust: &Trust) -> Result<Self, UpdateError> {
        trust.verify(bytes, signature)?;
        let mut feed: Self = serde_json::from_slice(bytes).map_err(|_| fail("METADATA_INVALID"))?;
        feed.validate(trust)?;
        feed.authenticated_bytes = bytes.to_vec();
        feed.authenticated_signature = signature.to_owned();
        Ok(feed)
    }

    pub fn validate(&self, trust: &Trust) -> Result<(), UpdateError> {
        version(&self.version)?;
        if !matches!(self.schema_version, 1 | 2)
            || self.repository != trust.repository
            || Some(self.repository_id) != trust.repository_id
            || self.product != PRODUCT
            || self.channel != "stable"
            || self.platform != PLATFORM
            || self.tag != format!("v{}", self.version)
            || self.asset.name != asset_name(&self.version)
            || self.asset.size == 0
            || self.asset.size > MAX_INSTALLER_BYTES
            || self.asset.sha256.len() != 64
            || !self
                .asset
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || !valid_timestamp(&self.published_at)
        {
            return Err(fail("METADATA_INVALID"));
        }
        if self.withdrawn {
            return Err(fail("WITHDRAWN"));
        }
        if self.min_updater_schema != self.schema_version
            || self.data_schema.min > 1
            || self.data_schema.max < 1
        {
            return Err(fail("INCOMPATIBLE"));
        }
        if self.asset.signature.is_empty() || self.asset.signature.len() > 4096 {
            return Err(fail("SIGNATURE_INVALID"));
        }
        const LEGACY_REQUIRED: [&str; 4] = [
            "dmelopers-3d-block-pet.exe",
            "assets/tray.png",
            "assets/models/dmeloper/dmeloper.glb",
            "assets/models/dmeloper/default.png",
        ];
        let required: Vec<_> = LEGACY_REQUIRED
            .into_iter()
            .chain((self.schema_version == 2).then_some(crate::helper::WORKER_EXE))
            .collect();
        if self.asset.installed_files.len() != required.len()
            || required
                .iter()
                .any(|name| !self.asset.installed_files.contains_key(*name))
        {
            return Err(fail("METADATA_INVALID"));
        }
        let mut names = std::collections::BTreeSet::new();
        for (path, hash) in &self.asset.installed_files {
            if !safe_program_path(path)
                || !valid_sha256(hash)
                || !names.insert(path.to_ascii_lowercase())
            {
                return Err(fail("METADATA_INVALID"));
            }
        }
        match (self.schema_version, &self.installer) {
            (1, None) => {}
            (2, Some(installer)) => installer.validate(&self.asset.installed_files)?,
            _ => return Err(fail("METADATA_INVALID")),
        }
        Ok(())
    }

    /// Parsing future packaging identity is not authorization to run it through
    /// the current NSIS transaction. No caller may derive command-line arguments
    /// from a feed or silently substitute an installer adapter.
    pub fn require_supported_installer(&self) -> Result<(), UpdateError> {
        match (self.schema_version, &self.installer) {
            (1, None) => Ok(()),
            (2, Some(installer)) => {
                installer.validate(&self.asset.installed_files)?;
                if installer.format == "nsis" {
                    Ok(())
                } else {
                    Err(fail("INSTALLER_FORMAT_UNSUPPORTED"))
                }
            }
            _ => Err(fail("METADATA_INVALID")),
        }
    }

    pub fn release_url(&self) -> String {
        format!(
            "https://github.com/{}/releases/tag/{}",
            self.repository, self.tag
        )
    }

    pub fn download_url(&self) -> String {
        format!(
            "https://github.com/{}/releases/download/{}/{}",
            self.repository, self.tag, self.asset.name
        )
    }
}

impl InstallerProtocol {
    fn validate(
        &self,
        installed_files: &std::collections::BTreeMap<String, String>,
    ) -> Result<(), UpdateError> {
        if self.protocol_version != 1
            || self.worker.protocol_version != 2
            || self.worker.path != crate::helper::WORKER_EXE
            || !valid_sha256(&self.worker.sha256)
            || installed_files.get(&self.worker.path) != Some(&self.worker.sha256)
            || self.worker.size == 0
            || self.worker.size > 64 * 1024 * 1024
        {
            return Err(fail("METADATA_INVALID"));
        }
        match (self.format.as_str(), &self.msi) {
            ("nsis", None) => Ok(()),
            ("wix-burn", Some(msi)) => msi.validate(),
            _ => Err(fail("METADATA_INVALID")),
        }
    }
}

impl MsiIdentity {
    fn validate(&self) -> Result<(), UpdateError> {
        if self.name.len() > 240
            || self.name.contains('/')
            || !self.name.ends_with(".msi")
            || !safe_program_path(&self.name)
            || !valid_sha256(&self.sha256)
            || self.size == 0
            || self.size > MAX_INSTALLER_BYTES
            || !valid_msi_guid(&self.product_code)
            || !valid_msi_guid(&self.upgrade_code)
            || !valid_msi_guid(&self.package_code)
            || self.product_code == self.upgrade_code
            || self.product_code == self.package_code
            || self.upgrade_code == self.package_code
        {
            return Err(fail("METADATA_INVALID"));
        }
        Ok(())
    }
}

fn valid_msi_guid(value: &str) -> bool {
    value.len() == 38
        && value.starts_with('{')
        && value.ends_with('}')
        && value.bytes().enumerate().all(|(index, byte)| match index {
            0 => byte == b'{',
            37 => byte == b'}',
            9 | 14 | 19 | 24 => byte == b'-',
            _ => byte.is_ascii_digit() || (b'A'..=b'F').contains(&byte),
        })
}

pub fn allowed_url(url: &url::Url, metadata: bool) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && match url.host_str() {
            Some("raw.githubusercontent.com" | "api.github.com") => metadata,
            Some(
                "github.com"
                | "release-assets.githubusercontent.com"
                | "objects.githubusercontent.com",
            ) => !metadata,
            _ => false,
        }
}

pub fn validate_release(bytes: &[u8], feed: &Feed) -> Result<(), UpdateError> {
    let release: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| fail("METADATA_INVALID"))?;
    if release["tag_name"] != feed.tag
        || release["draft"] != false
        || release["prerelease"] != false
        || release["html_url"] != feed.release_url()
        || release["immutable"] != true
    {
        return Err(fail("RELEASE_INVALID"));
    }
    let assets = release["assets"]
        .as_array()
        .ok_or_else(|| fail("ASSET_MISSING"))?;
    let expected = [
        feed.asset.name.clone(),
        format!("{}.sig", feed.asset.name),
        "stable.json".into(),
        "stable.json.sig".into(),
    ];
    if assets.len() != expected.len()
        || expected
            .iter()
            .any(|name| assets.iter().filter(|asset| asset["name"] == *name).count() != 1)
    {
        return Err(fail("ASSET_MISSING"));
    }
    for asset in assets {
        let name = asset["name"]
            .as_str()
            .ok_or_else(|| fail("ASSET_MISSING"))?;
        let limit = if name.ends_with(".sig") {
            4096
        } else if name == "stable.json" {
            MAX_METADATA_BYTES
        } else {
            MAX_INSTALLER_BYTES
        };
        if asset["state"] != "uploaded"
            || !asset["size"].as_u64().is_some_and(|n| n > 0 && n <= limit)
            || asset["browser_download_url"]
                != format!(
                    "https://github.com/{}/releases/download/{}/{name}",
                    feed.repository, feed.tag
                )
            || !asset["digest"]
                .as_str()
                .is_some_and(|s| s.strip_prefix("sha256:").is_some_and(valid_sha256))
        {
            return Err(fail("INTEGRITY_FAILED"));
        }
    }
    let matches: Vec<_> = assets
        .iter()
        .filter(|asset| asset["name"] == feed.asset.name)
        .collect();
    if matches.len() != 1 {
        return Err(fail("ASSET_MISSING"));
    }
    let asset = matches[0];
    if asset["size"].as_u64() != Some(feed.asset.size)
        || asset["digest"] != format!("sha256:{}", feed.asset.sha256)
        || asset["browser_download_url"] != feed.download_url()
        || asset["state"] != "uploaded"
    {
        return Err(fail("INTEGRITY_FAILED"));
    }
    Ok(())
}

pub fn validate_asset_bytes(release: &[u8], name: &str, bytes: &[u8]) -> Result<(), UpdateError> {
    use sha2::{Digest, Sha256};
    let release: serde_json::Value =
        serde_json::from_slice(release).map_err(|_| fail("METADATA_INVALID"))?;
    let matching: Vec<_> = release["assets"]
        .as_array()
        .ok_or_else(|| fail("ASSET_MISSING"))?
        .iter()
        .filter(|asset| asset["name"] == name)
        .collect();
    if matching.len() != 1
        || matching[0]["size"].as_u64() != Some(bytes.len() as u64)
        || matching[0]["digest"] != format!("sha256:{:x}", Sha256::digest(bytes))
    {
        return Err(fail("INTEGRITY_FAILED"));
    }
    Ok(())
}

pub(crate) fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn safe_program_path(path: &str) -> bool {
    if path.is_empty()
        || path.contains(['\\', ':', '\0'])
        || path.starts_with('/')
        || path.len() > 512
        || matches!(
            path.to_ascii_lowercase().as_str(),
            "uninstall.exe" | "block-pet-install-mode.txt"
        )
    {
        return false;
    }
    path.split('/').all(|part| {
        let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        !part.is_empty()
            && part != "."
            && part != ".."
            && !part.ends_with(['.', ' '])
            && !part
                .chars()
                .any(|c| c.is_control() || "<>\"|?*".contains(c))
            && !matches!(
                stem.as_str(),
                "CON"
                    | "PRN"
                    | "AUX"
                    | "NUL"
                    | "COM1"
                    | "COM2"
                    | "COM3"
                    | "COM4"
                    | "COM5"
                    | "COM6"
                    | "COM7"
                    | "COM8"
                    | "COM9"
                    | "LPT1"
                    | "LPT2"
                    | "LPT3"
                    | "LPT4"
                    | "LPT5"
                    | "LPT6"
                    | "LPT7"
                    | "LPT8"
                    | "LPT9"
            )
    })
}

fn valid_timestamp(value: &str) -> bool {
    // Canonical publisher UTC seconds; no ambiguous local times or leap seconds.
    let b = value.as_bytes();
    if b.len() != 20
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || b[16] != b':'
        || b[19] != b'Z'
    {
        return false;
    }
    let parse = |range: std::ops::Range<usize>| -> Option<u32> {
        if !b[range.clone()].iter().all(u8::is_ascii_digit) {
            return None;
        }
        value[range].parse().ok()
    };
    let (Some(y), Some(m), Some(d), Some(h), Some(min), Some(s)) = (
        parse(0..4),
        parse(5..7),
        parse(8..10),
        parse(11..13),
        parse(14..16),
        parse(17..19),
    ) else {
        return false;
    };
    let days = match m {
        2 if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        _ => 0,
    };
    y >= 2026 && d > 0 && d <= days && h < 24 && min < 60 && s < 60
}
