//! Compile-time-only transport for a private, non-publishable upgrade baseline.
//! There is no runtime environment, path, URL, or trust override.
use super::{
    TransportResponse, UpdateError, fail,
    feed::{self, Trust},
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{borrow::Cow, collections::BTreeMap, sync::OnceLock};

pub const BINARY_MARKER: &str = "DMELoper_PRIVATE_UPDATE_QA_BASELINE_ONLY";
const FIXTURE: &str = include_str!(concat!(env!("OUT_DIR"), "/fixture.json"));
const INSTALLER: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/installer.exe"));

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Fixture {
    schema_version: u32,
    kind: String,
    qa_baseline: bool,
    baseline_version: String,
    target_version: String,
    trust: Trust,
    installer: Installer,
    routes: BTreeMap<String, Route>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Installer {
    name: String,
    size: u64,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Route {
    metadata: bool,
    body: Option<String>,
    installer: bool,
}

fn fixture() -> Result<&'static Fixture, UpdateError> {
    static VALUE: OnceLock<Result<Fixture, UpdateError>> = OnceLock::new();
    VALUE
        .get_or_init(|| {
            let value: Fixture =
                serde_json::from_str(FIXTURE).map_err(|_| fail("PRIVATE_QA_FIXTURE_INVALID"))?;
            if value.schema_version != 1
                || value.kind != "block-pet-private-qa-bundle"
                || !value.qa_baseline
                || value.baseline_version != env!("CARGO_PKG_VERSION")
                || !value.baseline_version.starts_with("0.9.")
                || feed::version(&value.baseline_version)? >= feed::version(&value.target_version)?
                || value.installer.name != feed::asset_name(&value.target_version)
                || value.installer.size != INSTALLER.len() as u64
                || value.installer.size > feed::MAX_INSTALLER_BYTES
                || value.installer.sha256 != format!("{:x}", Sha256::digest(INSTALLER))
                || value.trust.repository != feed::REPOSITORY
                || value.routes.len() != 8
            {
                return Err(fail("PRIVATE_QA_FIXTURE_INVALID"));
            }
            let release = format!(
                "https://github.com/{}/releases/download/v{}",
                feed::REPOSITORY,
                value.target_version
            );
            let expected = [
                (
                    format!(
                        "https://raw.githubusercontent.com/{}/updates/stable.json",
                        feed::REPOSITORY
                    ),
                    true,
                    false,
                ),
                (
                    format!(
                        "https://raw.githubusercontent.com/{}/updates/stable.json.sig",
                        feed::REPOSITORY
                    ),
                    true,
                    false,
                ),
                (
                    format!("https://api.github.com/repos/{}", feed::REPOSITORY),
                    true,
                    false,
                ),
                (
                    format!(
                        "https://api.github.com/repos/{}/releases/tags/v{}",
                        feed::REPOSITORY,
                        value.target_version
                    ),
                    true,
                    false,
                ),
                (format!("{release}/stable.json"), false, false),
                (format!("{release}/stable.json.sig"), false, false),
                (
                    format!("{release}/{}.sig", value.installer.name),
                    false,
                    false,
                ),
                (format!("{release}/{}", value.installer.name), false, true),
            ];
            for (url, metadata, installer) in expected {
                let route = value
                    .routes
                    .get(&url)
                    .ok_or_else(|| fail("PRIVATE_QA_FIXTURE_INVALID"))?;
                if route.metadata != metadata
                    || route.installer != installer
                    || (installer && route.body.is_some())
                    || (!installer
                        && route
                            .body
                            .as_ref()
                            .is_none_or(|body| body.len() as u64 > feed::MAX_METADATA_BYTES))
                {
                    return Err(fail("PRIVATE_QA_FIXTURE_INVALID"));
                }
            }
            Ok(value)
        })
        .as_ref()
        .map_err(Clone::clone)
}

pub fn trust() -> Result<Trust, UpdateError> {
    Ok(fixture()?.trust.clone())
}

pub(super) fn response(url: &str, metadata: bool) -> Result<TransportResponse, UpdateError> {
    let route = fixture()?
        .routes
        .get(url)
        .ok_or_else(|| fail("PRIVATE_QA_FIXTURE_INVALID"))?;
    if route.metadata != metadata {
        return Err(fail("PRIVATE_QA_FIXTURE_INVALID"));
    }
    Ok(TransportResponse::Fixture {
        bytes: if route.installer {
            Cow::Borrowed(INSTALLER)
        } else {
            Cow::Owned(
                route
                    .body
                    .as_ref()
                    .ok_or_else(|| fail("PRIVATE_QA_FIXTURE_INVALID"))?
                    .as_bytes()
                    .to_vec(),
            )
        },
        offset: 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn compiled_fixture_runs_the_real_feed_and_asset_verification_pipeline() {
        let feed = super::super::fresh_feed().await.unwrap();
        assert_eq!(feed.version, fixture().unwrap().target_version);
        assert_eq!(feed.asset.sha256, fixture().unwrap().installer.sha256);
        assert!(response("https://example.invalid/feed", true).is_err());
    }
}
