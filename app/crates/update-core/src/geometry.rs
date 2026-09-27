//! Window coordinates are derived from the selected viewport and current DPI.
//! Verify their native realization separately from durable preset settings.
use super::integrity::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
pub struct Position {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowObservation {
    pub position: Position,
    pub inner_size: Size,
    pub outer_size: Size,
    pub monitor_work_area: Rect,
    pub scale_factor: f64,
    pub minimum_size: Size,
}

/// Physical-pixel observations used by the native health validator. Retaining
/// this exact capture lets a suspended hidden webview be audited after cleanup.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub monitor_work_areas: Vec<Rect>,
    pub windows: BTreeMap<String, WindowObservation>,
}

impl Evidence {
    pub fn verify(&self, source: &Value, current: &Value) -> Result<()> {
        for label in ["main", "preference"] {
            let window = self.windows.get(label).ok_or("WINDOW_NATIVE_MISMATCH")?;
            verify_size(
                &source[label],
                &current[label],
                (window.inner_size.width, window.inner_size.height),
                (window.outer_size.width, window.outer_size.height),
                window.monitor_work_area,
                window.scale_factor,
                (window.minimum_size.width, window.minimum_size.height),
                label == "main",
            )?;
            verify_position(
                &source[label],
                &current[label],
                Rect {
                    x: window.position.x,
                    y: window.position.y,
                    width: window.outer_size.width,
                    height: window.outer_size.height,
                },
                &self.monitor_work_areas,
                label == "main",
            )?;
        }
        Ok(())
    }
}

pub fn verify_size(
    source: &Value,
    current: &Value,
    inner: (f64, f64),
    outer: (f64, f64),
    monitor: Rect,
    scale: f64,
    minimum: (f64, f64),
    main: bool,
) -> Result<()> {
    let actual = if main { outer } else { inner };
    for (key, value, limit, default, min) in [
        ("width", actual.0, monitor.width, 800.0 * scale, minimum.0),
        (
            "height",
            actual.1,
            (monitor.height - 40.0 * scale).max(100.0),
            720.0 * scale,
            minimum.1,
        ),
    ] {
        if current[key]
            .as_f64()
            .is_none_or(|saved| (saved - value).abs() > 1.0)
        {
            return Err("WINDOW_NATIVE_SIZE_MISMATCH".into());
        }
        // Main dimensions are the renderer's realized crop at this monitor DPI;
        // its desired crop, pan and scale are covered by the preset data proof.
        if !main
            && (source[key].as_f64().unwrap_or(default).min(limit).max(min) - value).abs() > 1.0
        {
            return Err("WINDOW_SIZE_CLAMP_MISMATCH".into());
        }
    }
    Ok(())
}
fn clamp(value: f64, start: f64, available: f64, size: f64) -> f64 {
    value.max(start).min(start + (available - size).max(0.0))
}
pub fn verify_position(
    source: &Value,
    current: &Value,
    rect: Rect,
    monitors: &[Rect],
    main: bool,
) -> Result<()> {
    for (key, native) in [("x", rect.x), ("y", rect.y)] {
        if current[key]
            .as_f64()
            .is_none_or(|saved| (saved - native).abs() > 1.0)
        {
            return Err("WINDOW_NATIVE_MISMATCH".into());
        }
    }
    let origin = |axis: &str, origin_key: &str, native: f64| -> Option<f64> {
        if main {
            if let (Some(before), Some(after)) =
                (source[origin_key].as_f64(), current[origin_key].as_f64())
            {
                return Some(before + native - after);
            }
        }
        source[axis].as_f64()
    };
    let Some(x) = origin("x", "viewportOriginX", rect.x) else {
        return Ok(());
    };
    let Some(y) = origin("y", "viewportOriginY", rect.y) else {
        return Ok(());
    };
    // Changes are allowed only when they are the clamp of the original origin
    // for the rendered native viewport. Preset crop/scale remain data-hashed.
    if !monitors.iter().any(|m| {
        (clamp(x, m.x, m.width, rect.width) - rect.x).abs() <= 1.0
            && (clamp(y, m.y, m.height, rect.height) - rect.y).abs() <= 1.0
    }) {
        return Err("WINDOW_CLAMP_MISMATCH".into());
    }
    Ok(())
}
