use super::model;

use model::{Config, Model, Observation, Phase, Rule, RuleKind};
use serde_json::json;

fn config() -> Config {
    Config::read(json!({"enabled":true,"applications":["C:\\Apps\\Player.exe"]})).unwrap()
}
fn application() -> Rule {
    Rule {
        kind: RuleKind::Application,
        index: 0,
    }
}

#[test]
fn additive_config_validates_values_without_reinterpreting_unknown_fields() {
    assert!(
        Config::read(json!({"enabled":false,"applications":[],"sites":[],"future":{"value":1}}))
            .is_some()
    );
    for raw in [
        json!({"enabled":"true","applications":[],"sites":[]}),
        json!({"enabled":true,"applications":["player.exe"],"sites":[]}),
        json!({"enabled":true,"applications":["C:\\a..\\Player.exe"],"sites":[]}),
        json!({"enabled":true,"applications":["C:\\a \\Player.exe"],"sites":[]}),
        json!({"enabled":true,"applications":["C:\\a:b\\Player.exe"],"sites":[]}),
    ] {
        assert!(Config::read(raw).is_none());
    }
    assert_eq!(
        Config::read(json!({"enabled":true,"applications":[],"sites":null})),
        Some(Config {
            enabled: true,
            applications: vec![]
        })
    );
}

#[test]
fn rule_boundaries_preserve_path_identity() {
    let config = config();
    assert!(config.application("c:\\apps\\PLAYER.EXE").is_some());
    assert!(config.application("C:\\Other\\Player.exe").is_none());
    assert!(model::same_path(
        "C:\\Apps\\Ä\\Pet.exe",
        "c:/apps/ä/pet.EXE"
    ));
}

#[test]
fn only_a_stable_exit_ends_a_manual_show_visit() {
    let mut model = Model::default();
    model.configure(Some(config()));
    assert!(!model.status.ready);
    model.observe(Observation::Match(application()), 100);
    assert!(model.status.suppressed);
    let visit = model.status.visit;
    assert!(model.show_current_visit(model.status.revision, visit));
    model.observe(Observation::Own, 200);
    model.observe(Observation::Unavailable, 300);
    model.observe(Observation::Match(application()), 400);
    assert_eq!(model.status.state, Phase::Bypassed);
    model.observe(Observation::Outside, 500);
    model.observe(Observation::Match(application()), 800);
    assert_eq!(model.status.visit, visit);
    assert!(!model.status.suppressed);
    model.observe(Observation::Outside, 900);
    model.observe(Observation::Outside, 1400);
    model.observe(Observation::Match(application()), 1500);
    assert!(model.status.suppressed);
    assert_ne!(model.status.visit, visit);
}

#[test]
fn failures_disable_only_transient_suppression_and_stale_override_cannot_restore_it() {
    let mut model = Model::default();
    model.configure(Some(config()));
    model.observe(Observation::Match(application()), 0);
    let previous = model.status.clone();
    model.observe(Observation::Unavailable, 100);
    assert!(!model.status.suppressed);
    model.configure(Some(Config::default()));
    assert!(!model.show_current_visit(previous.revision, previous.visit));
    model.observe(Observation::Match(application()), 1000);
    assert_eq!(model.status.state, Phase::Off);
    assert!(!model.status.suppressed);
    model.configure(None);
    assert_eq!(model.status.state, Phase::Invalid);
    assert!(model.status.ready);
}

#[test]
fn duplicate_config_and_observations_do_not_publish_new_revisions() {
    let mut model = Model::default();
    assert!(model.configure(Some(config())));
    let revision = model.status.revision;
    assert!(!model.configure(Some(config())));
    model.observe(Observation::Match(application()), 0);
    let sequence = model.status.sequence;
    assert!(!model.observe(Observation::Match(application()), 500));
    assert_eq!(
        (model.status.revision, model.status.sequence),
        (revision, sequence)
    );
}

#[test]
fn parking_releases_suppression_without_ending_a_manual_show_visit() {
    let mut model = Model::default();
    model.configure(Some(config()));
    model.observe(Observation::Match(application()), 0);
    let visit = model.status.visit;
    let revision = model.status.revision;
    assert!(model.set_desktop_visible(false));
    assert!(!model.active());
    assert!(!model.status.suppressed);
    let parked = model.status.clone();
    assert!(!model.observe(Observation::Outside, 10000));
    assert_eq!(model.status, parked);
    assert!(model.show_current_visit(revision, visit));
    assert!(model.set_desktop_visible(true));
    model.observe(Observation::Match(application()), 10000);
    assert_eq!(model.status.state, Phase::Bypassed);
    assert_eq!(model.status.visit, visit);
    model.observe(Observation::Outside, 11000);
    model.observe(Observation::Outside, 11500);
    model.observe(Observation::Match(application()), 12000);
    assert!(model.status.suppressed);
    assert_ne!(model.status.visit, visit);
}

#[test]
fn compiled_rules_preserve_unicode_windows_identity_and_original_indices() {
    let config = Config::read(json!({"enabled": true, "applications": [
        "C:\\Apps\\First.exe", "C:\\Apps\\Ä\\Pet.exe", "C:\\Apps\\Last.exe"
    ]}))
    .unwrap();
    let mut model = Model::default();
    model.configure(Some(config.clone()));
    for path in [
        "C:\\Apps\\First.exe",
        "c:/apps/ä/pet.EXE",
        r"\\?\C:\Apps\Last.exe",
        "C:\\Other\\First.exe",
    ] {
        assert_eq!(model.application(path), config.application(path));
    }
    model.configure(Some(Config::default()));
    assert!(model.application("C:\\Apps\\First.exe").is_none());
}
