use serde::{Deserialize, Serialize};

use super::ErrorCode;

#[cfg(not(feature = "test-repository"))]
pub(super) const REPOSITORY: &str = "d-meloper/dmelopers-block-pet";
#[cfg(not(feature = "test-repository"))]
pub(super) const REPOSITORY_ID: u64 = 1_390_031_914;
#[cfg(feature = "test-repository")]
pub(super) const REPOSITORY: &str = "oup030416/dmelopers-block-pet-test";
#[cfg(feature = "test-repository")]
pub(super) const REPOSITORY_ID: u64 = 1_390_032_052;
pub(super) const FEED_MAX_AGE: u64 = 24 * 60 * 60;
pub(super) const FUTURE_TOLERANCE: u64 = 5 * 60;
const MAX_ASSET_SIZE: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Feed {
    pub schema_version: u32,
    pub repository: String,
    pub repository_id: u64,
    pub visibility: String,
    pub verified_at: String,
    // Explicit null means no stable release. A missing field is malformed.
    #[serde(deserialize_with = "deserialize_latest")]
    pub latest: Option<Release>,
}

fn deserialize_latest<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Release>, D::Error> {
    Option::<Release>::deserialize(deserializer)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Release {
    pub version: String,
    pub tag: String,
    pub platform: String,
    pub installer: Asset,
    pub signature: Asset,
    pub published_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Asset {
    pub name: String,
    pub size: u64,
    pub sha256: String,
}

impl Feed {
    /// Validate identity even for an expired cache; freshness is checked separately.
    pub fn validate(&self) -> Result<u64, ErrorCode> {
        if self.schema_version != 2
            || self.repository != REPOSITORY
            || self.repository_id != REPOSITORY_ID
            || self.visibility != "public"
        {
            return Err(ErrorCode::InvalidFeed);
        }
        let verified_at = timestamp(&self.verified_at).ok_or(ErrorCode::InvalidFeed)?;
        if let Some(release) = &self.latest {
            version(&release.version).ok_or(ErrorCode::InvalidFeed)?;
            let expected_name = format!("dmelopers-block-pet_{}_x64-setup.exe", release.version);
            if release.tag != format!("v{}", release.version)
                || release.platform != "windows-x86_64"
                || !release.installer.valid(&expected_name)
                || !release.signature.valid(&format!("{expected_name}.sig"))
                || timestamp(&release.published_at)
                    .is_none_or(|published_at| published_at > verified_at)
            {
                return Err(ErrorCode::InvalidFeed);
            }
        }
        Ok(verified_at)
    }

    pub fn validate_fresh(&self, now: u64) -> Result<(), ErrorCode> {
        let verified_at = self.validate()?;
        if verified_at > now.saturating_add(FUTURE_TOLERANCE) {
            return Err(ErrorCode::FutureFeed);
        }
        if now.saturating_sub(verified_at) > FEED_MAX_AGE {
            return Err(ErrorCode::StaleFeed);
        }
        Ok(())
    }
}

impl Asset {
    fn valid(&self, expected_name: &str) -> bool {
        self.name == expected_name
            && self.size > 0
            && self.size <= MAX_ASSET_SIZE
            && self.sha256.len() == 64
            && self
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }
}

/// Canonical stable versions only: no prefix, leading zeros, suffix or overflow.
pub(super) fn version(text: &str) -> Option<[u64; 3]> {
    let mut parts = text.split('.');
    let mut result = [0; 3];
    for target in &mut result {
        let part = parts.next()?;
        if part.is_empty()
            || (part.len() > 1 && part.starts_with('0'))
            || !part.bytes().all(|b| b.is_ascii_digit())
        {
            return None;
        }
        *target = part.parse().ok()?;
    }
    parts.next().is_none().then_some(result)
}

/// The producer uses UTC whole seconds, avoiding locale and timezone ambiguity.
pub(super) fn timestamp(text: &str) -> Option<u64> {
    let b = text.as_bytes();
    if b.len() != 20
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || b[16] != b':'
        || b[19] != b'Z'
    {
        return None;
    }
    let number = |range: std::ops::Range<usize>| -> Option<u64> {
        b[range].iter().try_fold(0_u64, |value, digit| {
            digit
                .is_ascii_digit()
                .then(|| value * 10 + u64::from(*digit - b'0'))
        })
    };
    let year = number(0..4)?;
    let month = number(5..7)?;
    let day = number(8..10)?;
    let hour = number(11..13)?;
    let minute = number(14..16)?;
    let second = number(17..19)?;
    if year < 1970 || !(1..=12).contains(&month) || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let months: [u64; 12] = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if day == 0 || day > months[month as usize - 1] {
        return None;
    }
    let leap_days = |last_year: u64| last_year / 4 - last_year / 100 + last_year / 400;
    let days = (year - 1970) * 365 + leap_days(year - 1) - leap_days(1969)
        + months[..month as usize - 1].iter().sum::<u64>()
        + day
        - 1;
    Some(days * 86_400 + hour * 3600 + minute * 60 + second)
}
