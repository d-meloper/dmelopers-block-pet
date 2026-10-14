use super::*;
use serde_json::json;

const OP: &str = "12345678-1234-4234-8234-123456789abc";
const PRESET: &str = "12345678-1234-4234-8234-123456789def";

fn historical_released_fixtures() -> Vec<Value> {
    [
        include_str!("../../src/features/presets/fixtures/historical/1.0.1.json"),
        include_str!("../../src/features/presets/fixtures/historical/1.1.0.json"),
        include_str!("../../src/features/presets/fixtures/historical/1.1.1.json"),
        include_str!("../../src/features/presets/fixtures/historical/1.1.2.json"),
    ].into_iter().map(|text| serde_json::from_str(text).unwrap()).collect()
}

fn historical_current_settings(source: &Value) -> Value {
    let additions = json!({
        "petAnimationMode":"default", "petShoulderTorsoConnected":false,
        "petRightArmDisabled":false, "petLeftArmDisabled":false,
        "petHeadbuttRecoilEnabled":true, "petHeadbuttRecoilStrengthPercent":50,
        "petHeadbuttRecoilWobblePercent":50, "petTypingHandLiftPercent":100,
        "petTypingBodyMotionPercent":100, "petTypingReturnSpeedPercent":100,
        "petHeadbuttMaxRadiusOffset":0, "petTypingMaxRadiusOffset":0,
    });
    let mut expected = source.clone();
    let preset = expected["preset"].as_object_mut().unwrap();
    for (key, value) in additions.as_object().unwrap() {
        preset.entry(key.clone()).or_insert_with(|| value.clone());
    }
    expected
}

#[test]
fn historical_released_fixtures_load_with_matching_ts_migrations() {
    for fixture in historical_released_fixtures() {
        assert_eq!(fixture["portableVersion"], 1);
        assert_eq!(fixture["catalogVersion"], 4);
        assert_eq!(fixture["valueCases"].as_array().unwrap().len(), 53);
        for scenario in fixture["cases"].as_array().unwrap() {
            let bytes = serde_json::to_vec(&scenario["portable"]).unwrap();
            let parsed = validate_document(&bytes).unwrap();
            assert_eq!(parsed.settings, scenario["portable"]["settings"]);
            assert!(crate::preset_compatibility::valid_executable(&parsed.settings),
                "{}/{}", fixture["provenance"]["version"], scenario["id"]);
            let old_expected = scenario.get("expectedLegacySettings")
                .unwrap_or(&scenario["portable"]["settings"]);
            assert_eq!(crate::preset_compatibility::migrate(&parsed.settings),
                historical_current_settings(old_expected));
            assert_eq!(serde_json::from_slice::<Value>(&serde_json::to_vec(&parsed).unwrap()).unwrap(),
                scenario["portable"]);
            assert_eq!(serde_json::to_vec(&scenario["portable"]).unwrap(), bytes);
        }
    }
}

#[test]
fn historical_released_portable_values_survive_native_file_readback() {
    let temp = tempfile::tempdir().unwrap();
    let folder = temp.path().join("Historical O'Brien 한글 安 😶");
    fs::create_dir(&folder).unwrap();
    let path = folder.join("released.petpreset");
    for fixture in historical_released_fixtures() {
        for scenario in fixture["cases"].as_array().unwrap() {
            let bytes = serde_json::to_vec(&scenario["portable"]).unwrap();
            write_preset_file(&path, &bytes).unwrap();
            assert_eq!(read_preset_file(&path).unwrap().as_bytes(), bytes);
            assert_eq!(serde_json::from_slice::<Value>(&fs::read(&path).unwrap()).unwrap(),
                scenario["portable"]);
        }
        for field in fixture["valueCases"].as_array().unwrap() {
            let pointer = format!("/{}", field["path"].as_array().unwrap().iter()
                .map(|part| part.as_str().unwrap()).collect::<Vec<_>>().join("/"));
            for value in field["values"].as_array().unwrap() {
                let mut document = fixture["cases"][0]["portable"].clone();
                *document["settings"].pointer_mut(&pointer).unwrap() = value.clone();
                let bytes = serde_json::to_vec(&document).unwrap();
                write_preset_file(&path, &bytes).unwrap();
                let disk = read_preset_file(&path).unwrap();
                assert_eq!(disk.as_bytes(), bytes);
                let parsed = validate_document(disk.as_bytes()).unwrap();
                assert!(crate::preset_compatibility::valid_executable(&parsed.settings),
                    "{}/{pointer}: {value}", fixture["provenance"]["version"]);
                let migrated = crate::preset_compatibility::migrate(&parsed.settings);
                assert_eq!(migrated.pointer(&pointer), Some(value));
                assert_eq!(migrated, historical_current_settings(&document["settings"]));
                assert_eq!(fs::read(&path).unwrap(), bytes);
            }
        }
    }
}

#[test]
fn historical_prepared_journals_preserve_source_and_complete_known_migrations() {
    let mut fixtures = historical_released_fixtures();
    fixtures.push(serde_json::from_str(include_str!(
        "../../src/features/presets/fixtures/historical/fixed-development.json")).unwrap());
    for fixture in fixtures {
        let temp = tempfile::tempdir().unwrap();
        let service = SkinLibraryService::new(Some(temp.path().into()));
        let previous = PreviousPresetState {
            collection: fixture["catalog"].clone(),
            snapshot: fixture["cases"][0]["snapshot"].clone(),
            visible: false,
        };
        let original = serde_json::to_vec(&previous).unwrap();
        let mut settings = previous.snapshot.clone();
        settings.as_object_mut().unwrap().remove("appearance");
        let mut current = previous.clone();
        current.snapshot = crate::preset_compatibility::migrate(&settings);
        current.snapshot["appearance"] = previous.snapshot["appearance"].clone();
        service.prepare_import(OP.into(), PRESET.into(), previous.clone(), request(10)).unwrap();
        let journal_bytes = fs::read(temp.path().join(JOURNAL)).unwrap();
        let restarted = SkinLibraryService::new(Some(temp.path().into()));
        let state_path = temp.path().join("historical-block.json");
        for change in 0..6 {
            let mut drift = current.clone();
            match change {
                0 => drift.snapshot["preset"]["cameraZoomPercent"] = json!(139),
                1 => drift.snapshot["preset"]["petAnimationMode"] = json!("headbutt"),
                2 => drift.snapshot["appearance"]["dmeloperSkinModel"] = json!("auto"),
                3 => drift.visible = true,
                4 => drift.collection["entries"][0]["favorite"] = json!(true),
                _ => drift.snapshot["preset"]["unreviewedMissingField"] = json!(false),
            }
            let disk_bytes = serde_json::to_vec(&block(&drift)).unwrap();
            write_verified(&state_path, &disk_bytes, FILE_LIMIT).unwrap();
            let disk = fs::read(&state_path).unwrap();
            assert_eq!(disk, disk_bytes);
            let disk_block: Value = serde_json::from_slice(&disk).unwrap();
            assert_eq!(restarted.finish_import(OP, false, &drift, &disk_block).unwrap_err(), "recovery");
            assert_eq!(fs::read(temp.path().join(JOURNAL)).unwrap(), journal_bytes);
            assert_eq!(serde_json::to_vec(&journal(temp.path()).unwrap().unwrap().previous).unwrap(), original);
            assert_eq!(restarted.list().unwrap().len(), 1);
        }
        let disk_bytes = serde_json::to_vec(&block(&current)).unwrap();
        write_verified(&state_path, &disk_bytes, FILE_LIMIT).unwrap();
        let disk = fs::read(&state_path).unwrap();
        assert_eq!(disk, disk_bytes);
        let disk_block: Value = serde_json::from_slice(&disk).unwrap();
        assert_eq!(disk_block["presetCollection"], previous.collection);
        assert!(matches_previous(&disk_block, &current));
        restarted.finish_import(OP, false, &current, &disk_block)
            .unwrap_or_else(|error| panic!("{} recovery: {error}", fixture["provenance"]["version"]));
        assert!(journal(temp.path()).unwrap().is_none());
        assert!(restarted.list().unwrap().is_empty());
        assert_eq!(serde_json::to_vec(&previous).unwrap(), original);
        assert_eq!(previous.collection, fixture["catalog"]);
    }
}

#[test]
fn historical_missing_defaults_never_replace_existing_values_or_accept_arbitrary_additions() {
    let old = previous();
    let mut current = old.clone();
    current.snapshot = crate::preset_compatibility::migrate(&old.snapshot);
    let original = serde_json::to_vec(&old).unwrap();
    assert!(valid_rollback(&old, &current));
    for pointer in [
        "/preset/deskTransparent", "/preset/deskHeightOffset", "/preset/deskWidthOffset",
        "/preset/deskDepthOffset", "/preset/deskColor", "/preset/dmeloperEyebrows/depthPercent",
        "/preset/lighting/key/color", "/preset/lighting/key/azimuthDegrees",
        "/preset/lighting/key/elevationDegrees", "/preset/lighting/key/strengthPercent",
    ] {
        let mut drift = current.clone();
        *drift.snapshot.pointer_mut(pointer).unwrap() = Value::Null;
        assert!(!valid_rollback(&old, &drift), "nondefault {pointer}");
    }
    for value in [Value::Null, json!("future"), json!(-999), json!({"future":true})] {
        let mut explicit = old.clone();
        explicit.snapshot["preset"]["deskColor"] = value.clone();
        explicit.snapshot["preset"]["dmeloperEyebrows"]["depthPercent"] = value.clone();
        explicit.snapshot["preset"]["futureUnknown"] = value;
        let mut acknowledged = explicit.clone();
        acknowledged.snapshot = crate::preset_compatibility::migrate(&explicit.snapshot);
        assert!(valid_rollback(&explicit, &acknowledged));
        acknowledged.snapshot["preset"]["deskColor"] = json!("#D9D9D9");
        assert!(!valid_rollback(&explicit, &acknowledged));
    }
    let mut arbitrary = current.clone();
    arbitrary.snapshot["preset"]["unreviewedDefault"] = json!(false);
    assert!(!valid_rollback(&old, &arbitrary));
    assert_eq!(serde_json::to_vec(&old).unwrap(), original);
}

#[test]
fn historical_contract_mutations_reject_missing_migrations_new_fields_ranges_and_choices() {
    let source = historical_released_fixtures()[0]["cases"][0]["portable"]["settings"].clone();
    let contract = crate::preset_compatibility::contract();
    assert!(crate::preset_compatibility::inspect_with(&source, contract).is_empty());
    let mut removed = contract.clone();
    removed["migrations"].as_array_mut().unwrap().retain(|id| id != "pet-animation-v1");
    assert!(crate::preset_compatibility::inspect_with(&source, &removed).iter()
        .any(|issue| issue.path == ["preset", "petAnimationMode"] && issue.reason == "missing"));
    let mut required = contract.clone();
    required["fields"].as_array_mut().unwrap().push(json!({
        "path":["preset","unmigratedRequiredOption"],"type":"boolean","label":"fixture"}));
    assert!(crate::preset_compatibility::inspect_with(&source, &required).iter()
        .any(|issue| issue.path == ["preset", "unmigratedRequiredOption"] && issue.reason == "missing"));
    let mut range = contract.clone();
    let field = range["fields"].as_array_mut().unwrap().iter_mut()
        .find(|field| field["path"] == json!(["preset","autoViewportPaddingPixels"])).unwrap();
    field.as_object_mut().unwrap().remove("rangeRef");
    field["min"] = json!(0);
    field["max"] = json!(15);
    let mut boundary = source.clone();
    boundary["preset"]["autoViewportPaddingPixels"] = json!(16);
    assert!(crate::preset_compatibility::inspect_with(&boundary, &range).iter().any(|issue| issue.reason == "range"));
    let mut choice = contract.clone();
    choice["fields"].as_array_mut().unwrap().iter_mut()
        .find(|field| field["path"] == json!(["preset","keyboardLegendLanguage"])).unwrap()["values"] = json!(["ko"]);
    boundary["preset"]["keyboardLegendLanguage"] = json!("en");
    assert!(crate::preset_compatibility::inspect_with(&boundary, &choice).iter().any(|issue| issue.reason == "choice"));
    assert_eq!(source, historical_released_fixtures()[0]["cases"][0]["portable"]["settings"]);
}

#[test]
fn shared_ranges_accept_fractional_values_and_reject_outside_portable_inputs() {
    let ranges: Value = serde_json::from_str(include_str!("../../src/config/presetRanges.json")).unwrap();
    for group in ["preset", "eyebrows"] {
        for (key, bounds) in ranges[group].as_object().unwrap() {
            let min = bounds["min"].as_f64().unwrap();
            let max = bounds["max"].as_f64().unwrap();
            for number in [min, max, min + (max - min) * 0.37, min - 0.0001, max + 0.0001] {
                let mut document = fixture();
                let target = if group == "preset" {
                    &mut document["settings"]["preset"]
                } else {
                    &mut document["settings"]["preset"]["dmeloperEyebrows"]
                };
                target[key] = json!(number);
                let result = validate_document(&serde_json::to_vec(&document).unwrap());
                assert_eq!(result.is_ok(), true, "{group}.{key}: {number}");
                if let Ok(restored) = result {
                    let target = if group == "preset" { &restored.settings["preset"] }
                        else { &restored.settings["preset"]["dmeloperEyebrows"] };
                    // JSON float parsing may differ by one binary ULP; it must
                    // never round the actual setting to a display step or integer.
                    assert!((target[key].as_f64().unwrap() - number).abs()
                        <= f64::EPSILON * number.abs().max(1.0));
                }
            }
        }
    }
}

#[test]
fn automatic_padding_portable_round_trip_preserves_thirty_and_legacy_values() {
    for padding in [0, 2, 10, 16, 17, 20, 30] {
        let mut document = fixture();
        document["settings"]["preset"]["autoViewportPaddingPixels"] = json!(padding);
        let restored = validate_document(&serde_json::to_vec(&document).unwrap()).unwrap();
        assert_eq!(restored.settings["preset"]["autoViewportPaddingPixels"], json!(padding));
        let reread = validate_document(&serde_json::to_vec(&restored).unwrap()).unwrap();
        assert_eq!(reread.settings["preset"]["autoViewportPaddingPixels"], json!(padding));
    }
    for padding in [json!(-1), json!(31), json!(16.5), json!("30"), Value::Null] {
        let mut document = fixture();
        document["settings"]["preset"]["autoViewportPaddingPixels"] = padding;
        assert!(validate_document(&serde_json::to_vec(&document).unwrap()).is_ok());
        assert!(!validate_settings(&document["settings"]));
    }
}

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../src/features/presets/fixtures/portable-v1.json"
    ))
    .unwrap()
}
fn png(shade: u8, height: u32) -> Vec<u8> {
    let pixels = image::RgbaImage::from_pixel(64, height, image::Rgba([shade, 60, 100, 255]));
    let mut bytes = io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(pixels)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    bytes.into_inner()
}
fn request(shade: u8) -> StoreSkinLibraryEntryRequest {
    StoreSkinLibraryEntryRequest {
        source: SkinLibrarySource::Java,
        display_name: "Fixture_User".into(),
        canonical_nickname: Some("Fixture_User".into()),
        original_filename: None,
        model: SkinLibraryModel::Wide,
        png_base64: general_purpose::STANDARD.encode(png(shade, 64)),
        thumbnail_png_base64: general_purpose::STANDARD.encode(png(shade, 64)),
        overwrite_existing: false,
    }
}
fn previous() -> PreviousPresetState {
    let mut snapshot = fixture()["settings"].clone();
    snapshot["appearance"] = json!({"selectedModelId":"dmeloper", "dmeloperSkinModel":"wide", "useDefaultDmeloperSkin":true});
    PreviousPresetState {
        collection: json!({"schemaVersion":4,"activeId":null,"entries":[]}),
        snapshot,
        visible: false,
    }
}
fn block(previous: &PreviousPresetState) -> Value {
    let mut customization = previous.snapshot["appearance"].clone();
    customization["preset"] = previous.snapshot["preset"].clone();
    json!({"presetCollection":previous.collection,"customization3d":customization,
        "window":{"visible":previous.visible,"opacity":previous.snapshot["opacity"]},
        "model":{"mirror":previous.snapshot["mirror"],"eyebrowAnimationEnabled":previous.snapshot["eyebrowAnimationEnabled"]}})
}

fn imported(previous: &PreviousPresetState, skin: &SkinLibraryReadResponse) -> PreviousPresetState {
    let mut snapshot = validate_document(&serde_json::to_vec(&fixture()).unwrap())
        .unwrap().settings;
    snapshot["appearance"] = json!({
        "selectedModelId":"dmeloper", "dmeloperSkinModel":"wide", "useDefaultDmeloperSkin":true,
        "activeSkinLibraryEntryId":skin.entry.id,
        "dmeloperSkinDataUrl":format!("data:image/png;base64,{}", skin.png_base64),
    });
    let mut expected = previous.clone();
    expected.collection["entries"].as_array_mut().unwrap().push(json!({
        "id":PRESET,"name":"Imported","favorite":false,"snapshot":snapshot,
    }));
    expected
}

#[test]
fn portable_v1_is_shared_with_the_frontend_and_has_no_local_state() {
    let mut doc = fixture();
    validate_document(&serde_json::to_vec(&doc).unwrap()).unwrap();
    doc["skin"] = json!({"mode":"image","model":"wide","nickname":"Fixture_User","pngBase64":general_purpose::STANDARD.encode(png(20,32))});
    validate_document(&serde_json::to_vec(&doc).unwrap()).unwrap();
    for path in ["thumbnail", "localPath", "activeSkinLibraryEntryId"] {
        let mut invalid = fixture();
        invalid["skin"][path] = json!("untrusted");
        assert!(validate_document(&serde_json::to_vec(&invalid).unwrap()).is_err());
    }
    doc["settings"]["preset"]["cameraZoomPercent"] = json!(1e200);
    assert_eq!(
        validate_document(&serde_json::to_vec(&doc).unwrap()).is_ok(),
        true
    );
    assert!(validate_document(&vec![b' '; FILE_LIMIT + 1]).is_err());
    doc = fixture();
    doc["version"] = json!(2);
    assert_eq!(
        validate_document(&serde_json::to_vec(&doc).unwrap()).unwrap_err(),
        "unsupportedVersion"
    );
    doc = fixture();
    doc["skin"]["nickname"] = json!("invalid-name");
    assert_eq!(
        validate_document(&serde_json::to_vec(&doc).unwrap()).unwrap_err(),
        "invalidNickname"
    );
}

#[test]
fn native_file_round_trip_preserves_unicode_and_rejects_invalid_inputs() {
    let temp = tempfile::tempdir().unwrap();
    let folder = temp.path().join("O'Brien 한글 安 😶");
    fs::create_dir(&folder).unwrap();
    let path = folder.join("공유.petpreset");
    let bytes = serde_json::to_vec(&fixture()).unwrap();
    write_verified(&path, &bytes, FILE_LIMIT).unwrap();
    assert_eq!(read_preset_file(&path).unwrap().as_bytes(), bytes);
    let mut edited = fixture();
    edited["name"] = json!("다음 😶");
    let next = serde_json::to_vec(&edited).unwrap();
    write_verified(&path, &next, FILE_LIMIT).unwrap();
    assert_eq!(read_preset_file(&path).unwrap().as_bytes(), next);
    assert!(read_preset_file(Path::new("relative.petpreset")).is_err());
    assert!(read_preset_file(&folder).is_err());
    let oversized = folder.join("oversized.petpreset");
    fs::File::create(&oversized)
        .unwrap()
        .set_len(FILE_LIMIT as u64 + 1)
        .unwrap();
    assert_eq!(read_preset_file(&oversized).unwrap_err(), "tooLarge");
    let target = folder.join("link.petpreset");
    if std::os::windows::fs::symlink_file(&path, &target).is_ok() {
        assert!(read_preset_file(&target).is_err());
    }
    assert_eq!(suggested_filename("CON"), "_CON.petpreset");
    assert_eq!(suggested_filename("bad/name."), "bad_name.petpreset");
}

#[test]
fn failed_export_preserves_the_destination_and_reports_a_save_error() {
    use std::os::windows::fs::OpenOptionsExt;
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("locked.petpreset");
    let bytes = serde_json::to_vec(&fixture()).unwrap();
    write_preset_file(&path, &bytes).unwrap();
    let locked = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&path)
        .unwrap();
    let mut changed = fixture();
    changed["name"] = json!("Replacement");
    assert_eq!(
        write_preset_file(&path, &serde_json::to_vec(&changed).unwrap()).unwrap_err(),
        "export"
    );
    drop(locked);
    assert_eq!(fs::read(&path).unwrap(), bytes);
    assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);

    let record = PresetImportJournal {
        version: 1,
        operation_id: OP.into(),
        preset_id: PRESET.into(),
        phase: "prepared".into(),
        previous: previous(),
        skin_entry_id: "a".repeat(64),
        created: None,
    };
    assert_eq!(
        write_journal(&temp.path().join("missing"), &record).unwrap_err(),
        "recovery"
    );
}

#[test]
fn identical_skin_is_reused_and_rollback_preserves_existing_metadata() {
    let temp = tempfile::tempdir().unwrap();
    let service = SkinLibraryService::new(Some(temp.path().into()));
    let existing = service.store(request(10)).unwrap();
    let before = fs::read(temp.path().join(MANIFEST_FILE)).unwrap();
    let previous = previous();
    let prepared = service
        .prepare_import(OP.into(), PRESET.into(), previous.clone(), request(10))
        .unwrap();
    assert_eq!(prepared, existing);
    assert!(journal(temp.path()).unwrap().unwrap().created.is_none());
    assert!(service.ensure_no_preset_import().is_err());
    service
        .finish_import(OP, false, &previous, &block(&previous))
        .unwrap();
    assert_eq!(fs::read(temp.path().join(MANIFEST_FILE)).unwrap(), before);
    assert_eq!(service.list().unwrap(), vec![existing]);
}

#[test]
fn changed_nickname_becomes_a_separate_local_skin_and_restart_rollback_removes_only_owned_assets() {
    let temp = tempfile::tempdir().unwrap();
    let service = SkinLibraryService::new(Some(temp.path().into()));
    let existing = service.store(request(10)).unwrap();
    let before = service.read(&existing.id).unwrap();
    let unrelated = temp
        .path()
        .join(RAW_DIRECTORY)
        .join(format!("{}.png", "f".repeat(64)));
    fs::write(&unrelated, "retained orphan evidence").unwrap();
    let previous = previous();
    let fresh = service
        .prepare_import(OP.into(), PRESET.into(), previous.clone(), request(30))
        .unwrap();
    assert_eq!(fresh.source, SkinLibrarySource::Local);
    assert_ne!(fresh.id, existing.id);
    assert_eq!(service.read(&existing.id).unwrap(), before);
    // The native journal also supports a new process with no old JS objects.
    let restarted = SkinLibraryService::new(Some(temp.path().into()));
    assert_eq!(journal(temp.path()).unwrap().unwrap().phase, "prepared");
    restarted
        .finish_import(OP, false, &previous, &block(&previous))
        .unwrap();
    assert_eq!(restarted.list().unwrap(), vec![existing]);
    assert!(
        !temp
            .path()
            .join(RAW_DIRECTORY)
            .join(format!("{}.png", fresh.png_sha256))
            .exists()
    );
    assert_eq!(
        fs::read_to_string(&unrelated).unwrap(),
        "retained orphan evidence"
    );
    assert!(journal(temp.path()).unwrap().is_none());
}

#[test]
fn commit_requires_saved_inactive_target_and_retains_an_idempotent_receipt() {
    let temp = tempfile::tempdir().unwrap();
    let service = SkinLibraryService::new(Some(temp.path().into()));
    let previous = previous();
    let entry = service
        .prepare_import(OP.into(), PRESET.into(), previous.clone(), request(40))
        .unwrap();
    assert!(
        service
            .finish_import(OP, true, &previous, &block(&previous))
            .is_err()
    );
    let expected = imported(&previous, &service.read(&entry.id).unwrap());
    let saved = block(&expected);
    assert!(service.finish_import(OP, true, &expected, &block(&previous)).is_err());
    service.finish_import(OP, true, &expected, &saved).unwrap();
    assert_eq!(journal(temp.path()).unwrap().unwrap().phase, "committed");
    service.finish_import(OP, true, &expected, &saved).unwrap();
    assert!(
        service
            .finish_import(OP, false, &previous, &block(&previous))
            .is_err()
    );
    service.ensure_no_preset_import().unwrap();
    assert!(journal(temp.path()).unwrap().is_none());
    assert!(service.read(&entry.id).is_ok());
}

#[test]
fn import_commit_preserves_selected_and_unselected_existing_catalogs() {
    for selected in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let service = SkinLibraryService::new(Some(temp.path().into()));
        let mut previous = previous();
        previous.collection["entries"] = json!([
            {"id":"first","name":"First","favorite":true,"snapshot":previous.snapshot},
            {"id":"second","name":"Second","favorite":false,"snapshot":previous.snapshot},
        ]);
        if selected {
            previous.collection["activeId"] = json!("first");
        }
        let entry = service.prepare_import(OP.into(), PRESET.into(), previous.clone(), request(40)).unwrap();
        let expected = imported(&previous, &service.read(&entry.id).unwrap());
        service.finish_import(OP, true, &expected, &block(&expected)).unwrap();
        assert_eq!(expected.snapshot, previous.snapshot);
        assert_eq!(expected.visible, previous.visible);
        assert_eq!(expected.collection["activeId"], previous.collection["activeId"]);
    }
}

#[test]
fn import_commit_rejects_changed_live_state_and_unbound_or_invalid_target() {
    let temp = tempfile::tempdir().unwrap();
    let service = SkinLibraryService::new(Some(temp.path().into()));
    let previous = previous();
    let entry = service.prepare_import(OP.into(), PRESET.into(), previous.clone(), request(40)).unwrap();
    let expected = imported(&previous, &service.read(&entry.id).unwrap());
    for field in ["selection", "settings", "visibility", "skinId", "png", "targetSettings"] {
        let mut changed = expected.clone();
        match field {
            "selection" => changed.collection["activeId"] = json!(PRESET),
            "settings" => changed.snapshot["opacity"] = json!(42),
            "visibility" => changed.visible = true,
            "skinId" => changed.collection["entries"][0]["snapshot"]["appearance"]["activeSkinLibraryEntryId"] = json!("a".repeat(64)),
            "png" => changed.collection["entries"][0]["snapshot"]["appearance"]["dmeloperSkinDataUrl"] = json!("data:image/png;base64,YQ=="),
            "targetSettings" => changed.collection["entries"][0]["snapshot"]["opacity"] = json!(101),
            _ => unreachable!(),
        }
        assert!(service.finish_import(OP, true, &changed, &block(&changed)).is_err(), "{field}");
        assert_eq!(journal(temp.path()).unwrap().unwrap().phase, "prepared");
        assert!(service.read(&entry.id).is_ok());
    }
    service.finish_import(OP, true, &expected, &block(&expected)).unwrap();
}

#[test]
fn failed_or_stale_recovery_preserves_journal_and_skin() {
    let temp = tempfile::tempdir().unwrap();
    let service = SkinLibraryService::new(Some(temp.path().into()));
    let previous = previous();
    let entry = service
        .prepare_import(OP.into(), PRESET.into(), previous.clone(), request(50))
        .unwrap();
    assert!(
        service
            .finish_import("wrong", false, &previous, &block(&previous))
            .is_err()
    );
    let mut changed = block(&previous);
    changed["window"]["visible"] = json!(true);
    assert!(
        service
            .finish_import(OP, false, &previous, &changed)
            .is_err()
    );
    assert!(journal(temp.path()).unwrap().is_some());
    assert!(service.read(&entry.id).is_ok());
    service
        .finish_import(OP, false, &previous, &block(&previous))
        .unwrap();
}

#[test]
fn stale_recovery_rejects_reordered_or_edited_existing_presets() {
    let temp = tempfile::tempdir().unwrap();
    let service = SkinLibraryService::new(Some(temp.path().into()));
    let mut previous = previous();
    previous.collection["entries"]
        .as_array_mut()
        .unwrap()
        .extend([
            json!({"id":"first","name":"First","favorite":false,"snapshot":previous.snapshot}),
            json!({"id":"existing","name":"Old","favorite":false,"snapshot":previous.snapshot}),
        ]);
    service
        .prepare_import(OP.into(), PRESET.into(), previous.clone(), request(60))
        .unwrap();
    let record = journal(temp.path()).unwrap().unwrap();
    assert!(recoverable_collection(&previous.collection, &record));
    let mut pending = previous.collection.clone();
    pending["activeId"] = json!(PRESET);
    pending["entries"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":PRESET}));
    assert!(recoverable_collection(&pending, &record));
    pending["activeId"] = previous.collection["activeId"].clone();
    assert!(recoverable_collection(&pending, &record));
    pending["activeId"] = json!("unrelated");
    assert!(!recoverable_collection(&pending, &record));
    pending["activeId"] = previous.collection["activeId"].clone();
    pending["entries"].as_array_mut().unwrap().swap(0, 1);
    assert!(!recoverable_collection(&pending, &record));
    pending["entries"].as_array_mut().unwrap().swap(0, 1);
    pending["entries"][1]["name"] = json!("Newer edit");
    assert!(!recoverable_collection(&pending, &record));
    assert!(journal(temp.path()).unwrap().is_some());
}

#[test]
fn rollback_accepts_only_center_preserving_viewport_shrink_and_exact_appearance() {
    let previous = previous();
    let mut expected = previous.clone();
    expected.snapshot["preset"]["manualViewportRect"] =
        json!({"x":100,"y":50,"width":300,"height":322});
    assert!(valid_rollback(&previous, &expected));
    expected.snapshot["preset"]["manualViewportRect"]["x"] = json!(99);
    assert!(!valid_rollback(&previous, &expected));
    expected = previous.clone();
    expected.snapshot["preset"]["dmeloperPalmColor"] = json!("#abcdef");
    assert!(!valid_rollback(&previous, &expected));
    let mut saved = block(&previous);
    saved["customization3d"]["minecraftSkinUsername"] = json!("Unexpected");
    assert!(!matches_previous(&saved, &previous));
}

const RELEASED_MISSING_MOTION_KEYS: [&str; 12] = [
    "petAnimationMode", "petShoulderTorsoConnected", "petRightArmDisabled",
    "petLeftArmDisabled", "petHeadbuttRecoilEnabled", "petHeadbuttRecoilStrengthPercent",
    "petHeadbuttRecoilWobblePercent", "petTypingHandLiftPercent", "petTypingBodyMotionPercent",
    "petTypingReturnSpeedPercent", "petHeadbuttMaxRadiusOffset", "petTypingMaxRadiusOffset",
];

fn released_rollback() -> (PreviousPresetState, PreviousPresetState) {
    let mut current = previous();
    current.snapshot = crate::preset_compatibility::migrate(&current.snapshot);
    // The released journal has the same stored scene but none of the twelve
    // subsequently approved fields. Its raw catalog/source must remain exact.
    current.collection["entries"] = json!([
        {"id":"first","name":"First","favorite":false,"snapshot":current.snapshot,
            "sourceSettings":{"preset":{"futureField":{"keep":true}}}},
        {"id":"second","name":"Second","favorite":true,"snapshot":current.snapshot},
    ]);
    current.collection["activeId"] = json!("first");
    let mut released = current.clone();
    for key in RELEASED_MISSING_MOTION_KEYS {
        released.snapshot["preset"].as_object_mut().unwrap().remove(key);
        for entry in released.collection["entries"].as_array_mut().unwrap() {
            entry["snapshot"]["preset"].as_object_mut().unwrap().remove(key);
        }
    }
    current.collection = released.collection.clone();
    (released, current)
}

#[test]
fn released_rollback_accepts_only_missing_authored_motion_defaults_without_mutating_source() {
    let (released, current) = released_rollback();
    let before = serde_json::to_vec(&released).unwrap();
    assert!(valid_rollback(&released, &released));
    assert!(valid_rollback(&released, &current));
    for key in RELEASED_MISSING_MOTION_KEYS {
        assert!(released.snapshot["preset"].get(key).is_none());
        let mut one = released.clone();
        one.snapshot["preset"][key] = current.snapshot["preset"][key].clone();
        assert!(valid_rollback(&released, &one), "{key}");
        for value in [Value::Null, json!("invalid"), json!({"value":100}),
            match current.snapshot["preset"][key].clone() {
                Value::Bool(value) => json!(!value),
                Value::Number(value) => json!(value.as_f64().unwrap() + 0.125),
                _ => json!("headbutt"),
            }] {
            let mut changed = current.clone();
            changed.snapshot["preset"][key] = value.clone();
            assert!(!valid_rollback(&released, &changed), "{key}: {value}");
            // Explicit values, including invalid/future source values, can
            // never be replaced by the newly authored default during rollback.
            let mut explicit = current.clone();
            explicit.snapshot["preset"][key] = value;
            assert!(valid_rollback(&explicit, &explicit));
            assert!(!valid_rollback(&explicit, &current), "existing {key}");
            let mut missing = explicit.clone();
            missing.snapshot["preset"].as_object_mut().unwrap().remove(key);
            assert!(!valid_rollback(&explicit, &missing), "removed {key}");
        }
    }
    assert_eq!(serde_json::to_vec(&released).unwrap(), before);
}

#[test]
fn released_rollback_keeps_catalog_visibility_appearance_and_viewport_guards_exact() {
    let (released, current) = released_rollback();
    for change in 0..8 {
        let mut changed = current.clone();
        match change {
            0 => changed.collection["activeId"] = Value::Null,
            1 => changed.collection["entries"].as_array_mut().unwrap().swap(0, 1),
            2 => changed.collection["entries"][0]["sourceSettings"]["preset"]["futureField"] = json!(false),
            3 => changed.visible = true,
            4 => changed.snapshot["appearance"]["minecraftSkinUsername"] = json!("Changed_User"),
            5 => changed.snapshot["preset"]["cameraZoomPercent"] = json!(137),
            6 => changed.snapshot["preset"]["futureMotionField"] = json!(0),
            _ => changed.snapshot["futureRootField"] = json!({"keep":true}),
        }
        assert!(!valid_rollback(&released, &changed), "change {change}");
    }
    let mut shrunk = current.clone();
    shrunk.snapshot["preset"]["manualViewportRect"] =
        json!({"x":100,"y":50,"width":300,"height":322});
    assert!(valid_rollback(&released, &shrunk));
    shrunk.snapshot["preset"]["manualViewportRect"]["x"] = json!(99);
    assert!(!valid_rollback(&released, &shrunk));
    let mut future = released.clone();
    future.snapshot["preset"]["futureMotionField"] = json!({"keep":true});
    let mut same_future = current;
    same_future.snapshot["preset"]["futureMotionField"] = future.snapshot["preset"]["futureMotionField"].clone();
    assert!(valid_rollback(&future, &same_future));
    same_future.snapshot["preset"]["futureMotionField"] = Value::Null;
    assert!(!valid_rollback(&future, &same_future));
}

#[test]
fn prepared_released_journal_survives_rejected_drift_and_finishes_default_only_recovery() {
    let temp = tempfile::tempdir().unwrap();
    let service = SkinLibraryService::new(Some(temp.path().into()));
    let (released, current) = released_rollback();
    let original = serde_json::to_vec(&released).unwrap();
    service.prepare_import(OP.into(), PRESET.into(), released.clone(), request(10)).unwrap();
    let journal_bytes = fs::read(temp.path().join(JOURNAL)).unwrap();
    let restarted = SkinLibraryService::new(Some(temp.path().into()));
    let mut changed = current.clone();
    changed.snapshot["preset"]["petAnimationMode"] = json!("headbutt");
    assert_eq!(restarted.finish_import(OP, false, &changed, &block(&changed)).unwrap_err(), "recovery");
    assert_eq!(fs::read(temp.path().join(JOURNAL)).unwrap(), journal_bytes);
    assert_eq!(serde_json::to_vec(&journal(temp.path()).unwrap().unwrap().previous).unwrap(), original);
    restarted.finish_import(OP, false, &current, &block(&current)).unwrap();
    assert!(journal(temp.path()).unwrap().is_none());
    assert!(restarted.list().unwrap().is_empty());
    assert_eq!(serde_json::to_vec(&released).unwrap(), original);
}

#[test]
fn eyebrow_depth_preserves_legacy_defaults_and_rejects_invalid_external_values() {
    let legacy = validate_document(&serde_json::to_vec(&fixture()).unwrap()).unwrap();
    assert!(legacy.settings["preset"]["dmeloperEyebrows"].get("depthPercent").is_none());
    assert_eq!(crate::preset_compatibility::migrate(&legacy.settings)["preset"]["dmeloperEyebrows"]["depthPercent"], 100);
    for depth in [0, 100, 200] {
        let mut doc = fixture();
        doc["settings"]["preset"]["dmeloperEyebrows"]["depthPercent"] = json!(depth);
        let parsed = validate_document(&serde_json::to_vec(&doc).unwrap()).unwrap();
        assert_eq!(parsed.settings["preset"]["dmeloperEyebrows"]["depthPercent"], depth);
    }
    for invalid in [json!(-1), json!(201), json!(null), json!("0"), json!(false)] {
        let mut doc = fixture();
        doc["settings"]["preset"]["dmeloperEyebrows"]["depthPercent"] = invalid;
        assert!(validate_document(&serde_json::to_vec(&doc).unwrap()).is_ok());
        assert!(!validate_settings(&doc["settings"]));
    }
    let mut doc = fixture();
    doc["settings"]["preset"]["dmeloperEyebrows"]["unknownDepth"] = json!(0);
    assert!(validate_document(&serde_json::to_vec(&doc).unwrap()).is_ok());
        assert!(!validate_settings(&doc["settings"]));
}


#[test]
fn desk_legacy_defaults_and_explicit_settings_round_trip_without_a_version_change() {
    let legacy = validate_document(&serde_json::to_vec(&fixture()).unwrap()).unwrap();
    assert_eq!(legacy.settings, fixture()["settings"]);
    let migrated = crate::preset_compatibility::migrate(&legacy.settings);
    let defaults: Value = crate::settings_defaults::section("preset").unwrap();
    assert_eq!(legacy.version, 1);
    assert_eq!(migrated["preset"]["deskTransparent"], json!(true));
    assert_eq!(migrated["preset"]["deskHeightOffset"], json!(0));
    assert_eq!(migrated["preset"]["deskWidthOffset"], json!(-1));
    assert_eq!(migrated["preset"]["deskDepthOffset"], defaults["deskDepthOffset"]);
    assert_eq!(migrated["preset"]["deskColor"], json!("#D9D9D9"));
    for height in [-1.0, 0.0, 1.0] {
        for transparent in [false, true] {
            let mut doc = fixture();
            doc["settings"]["preset"]["deskTransparent"] = json!(transparent);
            doc["settings"]["preset"]["deskHeightOffset"] = json!(height);
            doc["settings"]["preset"]["deskWidthOffset"] = json!(height);
            doc["settings"]["preset"]["deskDepthOffset"] = json!(-height);
            doc["settings"]["preset"]["deskColor"] = json!("#123aBC");
            let restored = validate_document(&serde_json::to_vec(&doc).unwrap()).unwrap();
            let round_trip = validate_document(&serde_json::to_vec(&restored).unwrap()).unwrap();
            assert_eq!(round_trip.settings, restored.settings);
            assert_eq!(restored.settings["preset"]["deskTransparent"], json!(transparent));
            assert_eq!(restored.settings["preset"]["deskHeightOffset"], json!(height));
            assert_eq!(restored.settings["preset"]["deskWidthOffset"], json!(height));
            assert_eq!(restored.settings["preset"]["deskDepthOffset"], json!(-height));
            assert_eq!(restored.settings["preset"]["deskColor"], json!("#123aBC"));
        }
    }
    let mut partial = fixture();
    partial["settings"]["preset"]["deskTransparent"] = json!(false);
    let restored = validate_document(&serde_json::to_vec(&partial).unwrap()).unwrap();
    assert_eq!(restored.settings["preset"]["deskTransparent"], json!(false));
    assert_eq!(crate::preset_compatibility::migrate(&restored.settings)["preset"]["deskHeightOffset"], json!(0));
}

#[test]
fn malformed_explicit_desk_fields_are_not_replaced_by_defaults() {
    for (key, values) in [
        ("deskTransparent", vec![json!(null), json!(1), json!("false")]),
        ("deskColor", vec![json!(null), json!(true), json!("#12345"), json!("#GGGGGG")]),
        ("deskHeightOffset", vec![json!(null), json!(false), json!("0"), json!(-1.01), json!(1.01)]),
        ("deskWidthOffset", vec![json!(null), json!(false), json!("0"), json!(-1.01), json!(1.01)]),
        ("deskDepthOffset", vec![json!(null), json!(false), json!("0"), json!(-1.01), json!(1.01)]),
        ("deskEnabled", vec![json!(true)]),
    ] {
        for value in values {
            let mut doc = fixture();
            doc["settings"]["preset"][key] = value;
            let restored = validate_document(&serde_json::to_vec(&doc).unwrap()).unwrap();
            assert_eq!(restored.settings, doc["settings"], "{key}");
            assert!(!validate_settings(&restored.settings), "{key}");
        }
    }
}
