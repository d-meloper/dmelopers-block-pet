use super::*;
use serde_json::json;

const OP: &str = "12345678-1234-4234-8234-123456789abc";
const PRESET: &str = "12345678-1234-4234-8234-123456789def";

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
                assert_eq!(result.is_ok(), number >= min && number <= max, "{group}.{key}: {number}");
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
        collection: json!({"schemaVersion":3,"activeId":"builtin:default","entries":[{"id":"builtin:default","name":"","builtin":true,"favorite":false,"snapshot":snapshot}]}),
        snapshot,
        visible: false,
    }
}
fn cat(previous: &PreviousPresetState) -> Value {
    let mut customization = previous.snapshot["appearance"].clone();
    customization["preset"] = previous.snapshot["preset"].clone();
    json!({"presetCollection":previous.collection,"customization3d":customization,
        "window":{"visible":previous.visible,"opacity":previous.snapshot["opacity"]},
        "model":{"mirror":previous.snapshot["mirror"],"eyebrowAnimationEnabled":previous.snapshot["eyebrowAnimationEnabled"]}})
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
        validate_document(&serde_json::to_vec(&doc).unwrap()).unwrap_err(),
        "invalidSettings"
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
        .finish_import(OP, false, &previous, &cat(&previous))
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
        .finish_import(OP, false, &previous, &cat(&previous))
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
fn commit_requires_saved_target_and_retains_an_idempotent_receipt() {
    let temp = tempfile::tempdir().unwrap();
    let service = SkinLibraryService::new(Some(temp.path().into()));
    let previous = previous();
    let entry = service
        .prepare_import(OP.into(), PRESET.into(), previous.clone(), request(40))
        .unwrap();
    assert!(
        service
            .finish_import(OP, true, &previous, &cat(&previous))
            .is_err()
    );
    let mut expected = previous.clone();
    expected.snapshot["appearance"]["activeSkinLibraryEntryId"] = json!(entry.id);
    expected.collection["activeId"] = json!(PRESET);
    expected.collection["entries"].as_array_mut().unwrap().push(json!({"id":PRESET,"name":"Imported","builtin":false,"favorite":false,"snapshot":expected.snapshot}));
    expected.visible = true;
    let saved = cat(&expected);
    service.finish_import(OP, true, &expected, &saved).unwrap();
    assert_eq!(journal(temp.path()).unwrap().unwrap().phase, "committed");
    service.finish_import(OP, true, &expected, &saved).unwrap();
    assert!(
        service
            .finish_import(OP, false, &previous, &cat(&previous))
            .is_err()
    );
    service.ensure_no_preset_import().unwrap();
    assert!(journal(temp.path()).unwrap().is_none());
    assert!(service.read(&entry.id).is_ok());
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
            .finish_import("wrong", false, &previous, &cat(&previous))
            .is_err()
    );
    let mut changed = cat(&previous);
    changed["window"]["visible"] = json!(true);
    assert!(
        service
            .finish_import(OP, false, &previous, &changed)
            .is_err()
    );
    assert!(journal(temp.path()).unwrap().is_some());
    assert!(service.read(&entry.id).is_ok());
    service
        .finish_import(OP, false, &previous, &cat(&previous))
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
        .push(json!({"id":"existing","name":"Old","snapshot":previous.snapshot}));
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
    let mut saved = cat(&previous);
    saved["customization3d"]["minecraftSkinUsername"] = json!("Unexpected");
    assert!(!matches_previous(&saved, &previous));
}

#[test]
fn eyebrow_depth_preserves_legacy_defaults_and_rejects_invalid_external_values() {
    let legacy = validate_document(&serde_json::to_vec(&fixture()).unwrap()).unwrap();
    assert_eq!(legacy.settings["preset"]["dmeloperEyebrows"]["depthPercent"], 100);
    for depth in [0, 100, 200] {
        let mut doc = fixture();
        doc["settings"]["preset"]["dmeloperEyebrows"]["depthPercent"] = json!(depth);
        let parsed = validate_document(&serde_json::to_vec(&doc).unwrap()).unwrap();
        assert_eq!(parsed.settings["preset"]["dmeloperEyebrows"]["depthPercent"], depth);
    }
    for invalid in [json!(-1), json!(201), json!(null), json!("0"), json!(false)] {
        let mut doc = fixture();
        doc["settings"]["preset"]["dmeloperEyebrows"]["depthPercent"] = invalid;
        assert_eq!(validate_document(&serde_json::to_vec(&doc).unwrap()).unwrap_err(), "invalidSettings");
    }
    let mut doc = fixture();
    doc["settings"]["preset"]["dmeloperEyebrows"]["unknownDepth"] = json!(0);
    assert_eq!(validate_document(&serde_json::to_vec(&doc).unwrap()).unwrap_err(), "invalidSettings");
}


#[test]
fn desk_legacy_defaults_and_explicit_settings_round_trip_without_a_version_change() {
    let legacy = validate_document(&serde_json::to_vec(&fixture()).unwrap()).unwrap();
    assert_eq!(legacy.version, 1);
    assert_eq!(legacy.settings["preset"]["deskTransparent"], json!(true));
    assert_eq!(legacy.settings["preset"]["deskHeightOffset"], json!(0));
    assert_eq!(legacy.settings["preset"]["deskColor"], json!("#D9D9D9"));
    for height in [-1.0, 0.0, 1.0] {
        for transparent in [false, true] {
            let mut doc = fixture();
            doc["settings"]["preset"]["deskTransparent"] = json!(transparent);
            doc["settings"]["preset"]["deskHeightOffset"] = json!(height);
            doc["settings"]["preset"]["deskColor"] = json!("#123aBC");
            let restored = validate_document(&serde_json::to_vec(&doc).unwrap()).unwrap();
            let round_trip = validate_document(&serde_json::to_vec(&restored).unwrap()).unwrap();
            assert_eq!(round_trip.settings, restored.settings);
            assert_eq!(restored.settings["preset"]["deskTransparent"], json!(transparent));
            assert_eq!(restored.settings["preset"]["deskHeightOffset"], json!(height));
            assert_eq!(restored.settings["preset"]["deskColor"], json!("#123aBC"));
        }
    }
    let mut partial = fixture();
    partial["settings"]["preset"]["deskTransparent"] = json!(false);
    let restored = validate_document(&serde_json::to_vec(&partial).unwrap()).unwrap();
    assert_eq!(restored.settings["preset"]["deskTransparent"], json!(false));
    assert_eq!(restored.settings["preset"]["deskHeightOffset"], json!(0));
}

#[test]
fn malformed_explicit_desk_fields_are_not_replaced_by_defaults() {
    for (key, values) in [
        ("deskTransparent", vec![json!(null), json!(1), json!("false")]),
        ("deskColor", vec![json!(null), json!(true), json!("#12345"), json!("#GGGGGG")]),
        ("deskHeightOffset", vec![json!(null), json!(false), json!("0"), json!(-1.01), json!(1.01)]),
        ("deskEnabled", vec![json!(true)]),
    ] {
        for value in values {
            let mut doc = fixture();
            doc["settings"]["preset"][key] = value;
            assert_eq!(
                validate_document(&serde_json::to_vec(&doc).unwrap()).unwrap_err(),
                "invalidSettings",
                "{key}"
            );
        }
    }
}
