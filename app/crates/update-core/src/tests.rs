use crate::feed::{self, Feed, Trust};
use serde_json::{Value, json};

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../src-tauri/src/update_delivery/signature-fixture.json"
    ))
    .unwrap()
}

pub(crate) fn protocol_fixture() -> Value {
    serde_json::from_str(include_str!("../tests/protocol-fixtures.json")).unwrap()
}

pub(crate) fn protocol_case(name: &str) -> (Feed, Trust) {
    let fixture = protocol_fixture();
    let case = fixture["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == name)
        .unwrap();
    let trust = Trust {
        schema_version: 1,
        repository: feed::OFFICIAL_REPOSITORY.into(),
        repository_id: Some(42),
        public_key: Some(fixture["publicKey"].as_str().unwrap().into()),
    };
    let feed = Feed::parse(
        case["feed"].as_str().unwrap().as_bytes(),
        case["signature"].as_str().unwrap(),
        &trust,
    )
    .unwrap();
    (feed, trust)
}

#[test]
fn signed_installer_protocol_cases_authenticate_before_accepting_or_rejecting_metadata() {
    let fixture = protocol_fixture();
    let trust = Trust {
        schema_version: 1,
        repository: feed::OFFICIAL_REPOSITORY.into(),
        repository_id: Some(42),
        public_key: Some(fixture["publicKey"].as_str().unwrap().into()),
    };
    for case in fixture["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let bytes = case["feed"].as_str().unwrap().as_bytes();
        let signature = case["signature"].as_str().unwrap();
        // Every malformed case has a valid signature. A cryptographic failure
        // must never hide a missing format, protocol, size or identity check.
        trust.verify(bytes, signature).unwrap();
        let parsed = Feed::parse(bytes, signature, &trust);
        assert_eq!(parsed.is_ok(), case["valid"].as_bool().unwrap(), "{name}");
        if let Ok(feed) = parsed {
            let supported = feed.require_supported_installer();
            assert_eq!(
                supported.is_ok(),
                case["supported"].as_bool().unwrap(),
                "{name}"
            );
            if name == "burn_v2_gated" {
                assert_eq!(supported.unwrap_err().code, "INSTALLER_FORMAT_UNSUPPORTED");
            }
        }
    }
}
pub(crate) fn sample() -> Feed {
    serde_json::from_value(json!({
        "schemaVersion":1,"repository":feed::REPOSITORY,"repositoryId":42,
        "product":feed::PRODUCT,"channel":"stable","platform":feed::PLATFORM,
        "version":"1.2.3","tag":"v1.2.3",
        "asset":{"name":feed::asset_name("1.2.3"),"size":42,"sha256":"a".repeat(64),
        "signature":fixture()["signature"],"installedFiles":{
            "dmelopers-3d-block-pet.exe":"a".repeat(64),
            "assets/tray.png":"b".repeat(64),
            "assets/models/dmeloper/dmeloper.glb":"c".repeat(64),
            "assets/models/dmeloper/default.png":"d".repeat(64)
        }},"minUpdaterSchema":1,"dataSchema":{"min":1,"max":1},"withdrawn":false,
        "publishedAt":"2026-09-09T00:00:00Z"
    }))
    .unwrap()
}

#[test]
fn legacy_feeds_keep_four_files_and_v2_requires_exactly_the_worker_and_schema_two() {
    let trust = Trust {
        schema_version: 1,
        repository: feed::REPOSITORY.into(),
        repository_id: Some(42),
        public_key: Some(fixture()["publicKey"].as_str().unwrap().into()),
    };
    let legacy = sample();
    legacy.validate(&trust).unwrap();
    let mut v2 = legacy.clone();
    v2.schema_version = 2;
    v2.min_updater_schema = 2;
    v2.asset
        .installed_files
        .insert(crate::helper::WORKER_EXE.into(), "e".repeat(64));
    v2.installer = Some(serde_json::from_value(json!({"format":"nsis","protocolVersion":1,
        "worker":{"path":crate::helper::WORKER_EXE,"sha256":"e".repeat(64),"size":42,"protocolVersion":2},
        "msi":null})).unwrap());
    v2.validate(&trust).unwrap();
    let mut incompatible = v2.clone();
    incompatible.min_updater_schema = 1;
    assert!(incompatible.validate(&trust).is_err());
    let mut missing = v2.clone();
    missing
        .asset
        .installed_files
        .remove(crate::helper::WORKER_EXE);
    assert!(missing.validate(&trust).is_err());
    let mut renamed = v2.clone();
    let hash = renamed
        .asset
        .installed_files
        .remove(crate::helper::WORKER_EXE)
        .unwrap();
    renamed
        .asset
        .installed_files
        .insert("Block-Pet-Update-Worker.exe".into(), hash);
    assert!(renamed.validate(&trust).is_err());
    let mut old_with_new_payload = v2.clone();
    old_with_new_payload.schema_version = 1;
    old_with_new_payload.min_updater_schema = 1;
    assert!(old_with_new_payload.validate(&trust).is_err());
    v2.schema_version = 3;
    assert!(v2.validate(&trust).is_err());
}
