//! Switch drag containment only when the cursor enters another monitor.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl Rect {
    fn valid(self) -> bool {
        self.width > 0 && self.height > 0
    }
    pub(super) fn contains(self, (x, y): (i32, i32)) -> bool {
        x >= self.x && x < self.x + self.width && y >= self.y && y < self.y + self.height
    }
}

pub(super) struct Monitor {
    pub id: isize,
    pub bounds: Rect,
    pub work_area: Rect,
}

pub(super) fn clamp_drag_rect(
    rect: Rect,
    cursor: (i32, i32),
    monitors: &[Monitor],
    active_monitor: isize,
) -> Option<(Rect, isize)> {
    let selected = monitors
        .iter()
        .find(|monitor| monitor.work_area.valid() && monitor.bounds.contains(cursor))
        .or_else(|| {
            monitors
                .iter()
                .find(|monitor| monitor.id == active_monitor && monitor.work_area.valid())
        })
        .or_else(|| monitors.iter().find(|monitor| monitor.work_area.valid()))?;
    let area = selected.work_area;
    // Oversized viewports retain their dimensions and align to the work-area origin.
    Some((
        Rect {
            x: rect
                .x
                .clamp(area.x, area.x + (area.width - rect.width).max(0)),
            y: rect
                .y
                .clamp(area.y, area.y + (area.height - rect.height).max(0)),
            ..rect
        },
        selected.id,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rect(x: i32, y: i32, width: i32, height: i32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }
    fn monitor(id: isize, x: i32, y: i32, width: i32, height: i32) -> Monitor {
        Monitor {
            id,
            bounds: rect(x, y, width, height),
            work_area: rect(x, y, width, height - 40),
        }
    }

    #[test]
    fn stays_on_current_display_until_the_cursor_crosses_then_switches_both_ways() {
        let monitors = [
            monitor(1, 0, 0, 1920, 1080),
            monitor(2, 1920, 0, 1280, 1024),
        ];
        let proposed = rect(1830, 300, 300, 200);
        assert_eq!(
            clamp_drag_rect(proposed, (1919, 400), &monitors, 1),
            Some((rect(1620, 300, 300, 200), 1))
        );
        assert_eq!(
            clamp_drag_rect(proposed, (1920, 400), &monitors, 1),
            Some((rect(1920, 300, 300, 200), 2))
        );
        assert_eq!(
            clamp_drag_rect(proposed, (1919, 400), &monitors, 2),
            Some((rect(1620, 300, 300, 200), 1))
        );
    }

    #[test]
    fn supports_negative_vertical_and_offset_displays_and_ignores_gaps() {
        let monitors = [
            monitor(1, 0, 0, 1920, 1080),
            monitor(2, -1600, -1080, 1600, 900),
        ];
        let proposed = rect(-200, -300, 300, 200);
        assert_eq!(
            clamp_drag_rect(proposed, (-10, -100), &monitors, 1),
            Some((rect(0, 0, 300, 200), 1))
        );
        assert_eq!(
            clamp_drag_rect(proposed, (-10, -500), &monitors, 1),
            Some((rect(-300, -420, 300, 200), 2))
        );
        assert_eq!(
            clamp_drag_rect(proposed, (-10, -100), &monitors, 2),
            Some((rect(-300, -420, 300, 200), 2))
        );
    }

    #[test]
    fn clamps_taskbar_edges_and_preserves_oversized_dimensions() {
        let monitors = [monitor(1, 0, 0, 1920, 1080)];
        assert_eq!(
            clamp_drag_rect(rect(-20, 1000, 300, 200), (10, 1070), &monitors, 1),
            Some((rect(0, 840, 300, 200), 1))
        );
        assert_eq!(
            clamp_drag_rect(rect(100, 200, 2500, 1400), (10, 500), &monitors, 1),
            Some((rect(0, 0, 2500, 1400), 1))
        );
        assert_eq!(
            clamp_drag_rect(rect(100, 200, 300, 200), (10, 500), &[], 1),
            None
        );
    }
}
