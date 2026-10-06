//! Settings readback compares exact JavaScript numbers, including slider arithmetic.
#[test]
fn settings_json_preserves_slider_number_bits() {
    for expected in [
        3.9000000000000004_f64,
        -29.099999999999998_f64,
        -27.900000000000002_f64,
        0.07800000000000001_f64,
        1.2345678901234567_f64,
    ] {
        let encoded = serde_json::to_string(&expected).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(parsed.as_f64().unwrap().to_bits(), expected.to_bits());
        let saved = serde_json::to_string(&parsed).unwrap();
        let restored: f64 = serde_json::from_str(&saved).unwrap();
        assert_eq!(restored.to_bits(), expected.to_bits());
    }
}
