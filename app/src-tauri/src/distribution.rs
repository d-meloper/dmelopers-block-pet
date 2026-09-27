//! Native channel identity is compiled in; renderer and persisted settings cannot select it.
use serde::Serialize;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Github,
    Store,
    Test,
    Development,
}

pub fn channel() -> Channel {
    if cfg!(feature = "test-repository") {
        Channel::Test
    } else if tauri::is_dev() {
        Channel::Development
    } else if cfg!(feature = "channel-store") {
        Channel::Store
    } else {
        Channel::Github
    }
}

impl Channel {
    pub fn identifier(self) -> &'static str {
        match self {
            Self::Github => "com.dmeloper.blockpet",
            Self::Store => "com.dmeloper.blockpet.store",
            Self::Test => "com.dmeloper.blockpet.test",
            Self::Development => "com.dmeloper.blockpet.development",
        }
    }
    pub fn official(self) -> bool {
        matches!(self, Self::Github | Self::Store)
    }
    #[cfg(not(feature = "channel-store"))]
    pub fn autostart_name(self) -> &'static str {
        match self {
            Self::Github | Self::Store => "DMeloper's Block Pet",
            Self::Test => "DMeloper's Block Pet Test",
            Self::Development => "DMeloper's Block Pet Development",
        }
    }
    pub fn lock_identity(self) -> &'static str {
        if self.official() {
            "Official"
        } else {
            self.identifier()
        }
    }
    pub fn update_url(self) -> String {
        match self {
            Self::Store => option_env!("DMELOPER_STORE_PRODUCT_ID")
                .filter(|id| id.len() == 12 && id.bytes().all(|c| c.is_ascii_alphanumeric()))
                .map(|id| format!("https://apps.microsoft.com/detail/{id}"))
                // Build checks without Partner Center identity can still open the installed library.
                .unwrap_or_else(|| "ms-windows-store://downloadsandupdates".into()),
            Self::Test => "https://github.com/oup030416/dmelopers-block-pet-test/releases".into(),
            _ => "https://github.com/d-meloper/dmelopers-block-pet/releases".into(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DistributionInfo {
    channel: Channel,
    data_root: String,
    local_data_root: String,
    update_url: String,
    data_schema: u32,
}

#[tauri::command]
pub fn distribution_info(
    roots: tauri::State<'_, crate::data_paths::DataRoots>,
) -> DistributionInfo {
    DistributionInfo {
        channel: channel(),
        data_root: roots.durable.to_string_lossy().into_owned(),
        local_data_root: roots.local.to_string_lossy().into_owned(),
        update_url: channel().update_url(),
        data_schema: 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_official_channels_share_identity() {
        assert_eq!(
            Channel::Github.lock_identity(),
            Channel::Store.lock_identity()
        );
        assert_ne!(
            Channel::Test.lock_identity(),
            Channel::Github.lock_identity()
        );
        assert_ne!(
            Channel::Development.identifier(),
            Channel::Test.identifier()
        );
    }
}
