use super::*;
use std::cell::Cell;

fn rect(x: i32, y: i32, width: i32, height: i32) -> Rect {
    Rect {
        x,
        y,
        width,
        height,
    }
}
fn layout() -> Vec<Monitor> {
    vec![
        Monitor {
            id: 1,
            bounds: rect(0, 0, 1920, 1080),
            work_area: rect(0, 30, 1920, 1010),
        },
        Monitor {
            id: 2,
            bounds: rect(-1600, -1080, 1600, 900),
            work_area: rect(-1600, -1080, 1560, 900),
        },
        Monitor {
            id: 3,
            bounds: rect(1920, 0, 1280, 1024),
            work_area: rect(1960, 0, 1240, 1024),
        },
    ]
}
fn read(id: isize) -> Option<Monitor> {
    layout().into_iter().find(|monitor| monitor.id == id)
}
#[test]
fn native_live_monitor_matches_full_clamp_for_crossings_gaps_taskbars_and_oversized_windows() {
    let positions = [
        (10, 1070, 1),
        (1919, 400, 1),
        (1920, 400, 3),
        (-10, -500, 2),
        (-10, -100, 0),
        (4000, 1200, 0),
    ];
    let proposals = [
        rect(-200, -300, 300, 200),
        rect(1830, 1000, 300, 200),
        rect(100, 200, 2500, 1400),
    ];
    for active in 1..=3 {
        for (x, y, point_monitor) in positions {
            for proposed in proposals {
                assert_eq!(
                    clamp_drag_with_live_monitor(
                        proposed,
                        (x, y),
                        active,
                        point_monitor,
                        read,
                        || panic!("normal monitor/gap must not enumerate")
                    ),
                    clamp_drag_rect(proposed, (x, y), &layout(), active),
                    "cursor={x},{y}, active={active}"
                );
            }
        }
    }
}
#[test]
fn native_live_monitor_100000_proposals_read_one_monitor_and_never_enumerate() {
    let reads = Cell::new(0);
    let proposed = rect(1830, 1000, 300, 200);
    let expected = clamp_drag_rect(proposed, (2000, 400), &layout(), 1);
    for _ in 0..100_000 {
        assert_eq!(
            clamp_drag_with_live_monitor(
                proposed,
                (2000, 400),
                1,
                3,
                |id| {
                    reads.set(reads.get() + 1);
                    assert_eq!(id, 3);
                    read(id)
                },
                || panic!("normal proposals must not enumerate")
            ),
            expected
        );
    }
    assert_eq!(reads.get(), 100_000);
}
#[test]
fn native_live_monitor_reads_updated_work_area_and_bounds_on_every_proposal() {
    let proposed = rect(1900, 1000, 300, 200);
    let before = clamp_drag_with_live_monitor(proposed, (500, 500), 1, 1, read, || unreachable!());
    let after = clamp_drag_with_live_monitor(
        proposed,
        (500, 500),
        1,
        1,
        |id| {
            let mut monitor = read(id).unwrap();
            monitor.bounds = rect(0, 0, 1280, 720);
            monitor.work_area = rect(0, 0, 1280, 680);
            Some(monitor)
        },
        || unreachable!(),
    );
    assert_eq!(before, Some((rect(1620, 840, 300, 200), 1)));
    assert_eq!(after, Some((rect(980, 480, 300, 200), 1)));
}
#[test]
fn native_live_monitor_removed_or_failed_handle_recovers_through_full_enumeration() {
    let proposed = rect(1830, 1000, 300, 200);
    for (cursor, active, point_monitor) in [((2000, 400), 1, 3), ((-10, -100), 99, 0)] {
        let calls = Cell::new(0);
        let actual = clamp_drag_with_live_monitor(
            proposed,
            cursor,
            active,
            point_monitor,
            |_| None,
            || {
                calls.set(calls.get() + 1);
                Some(layout())
            },
        );
        assert_eq!(actual, clamp_drag_rect(proposed, cursor, &layout(), active));
        assert_eq!(calls.get(), 1);
    }
}
#[test]
fn native_live_monitor_inconsistent_lookup_and_invalid_work_area_use_original_fallback() {
    let proposed = rect(1830, 1000, 300, 200);
    for stale_bounds in [false, true] {
        let calls = Cell::new(0);
        let actual = clamp_drag_with_live_monitor(
            proposed,
            (2000, 400),
            1,
            3,
            |id| {
                let mut monitor = read(id).unwrap();
                if stale_bounds {
                    monitor.bounds = rect(0, 0, 1920, 1080);
                } else {
                    monitor.work_area.width = 0;
                }
                Some(monitor)
            },
            || {
                calls.set(calls.get() + 1);
                Some(layout())
            },
        );
        assert_eq!(actual, clamp_drag_rect(proposed, (2000, 400), &layout(), 1));
        assert_eq!(calls.get(), 1);
    }
}
#[test]
fn native_live_monitor_failed_cursor_retains_active_and_failed_recovery_does_not_clamp() {
    let proposed = rect(-200, -300, 300, 200);
    assert_eq!(
        clamp_drag_with_live_monitor(
            proposed,
            (i32::MIN, i32::MIN),
            2,
            0,
            read,
            || unreachable!()
        ),
        clamp_drag_rect(proposed, (i32::MIN, i32::MIN), &layout(), 2)
    );
    assert_eq!(
        clamp_drag_with_live_monitor(proposed, (10, 10), 99, 0, |_| None, || None),
        None
    );
    assert_eq!(
        clamp_drag_with_live_monitor(proposed, (10, 10), 99, 0, |_| None, || Some(vec![])),
        None
    );
}
#[test]
fn native_live_monitor_new_target_does_not_depend_on_removed_active_monitor() {
    let proposed = rect(1830, 1000, 300, 200);
    assert_eq!(
        clamp_drag_with_live_monitor(proposed, (2000, 400), 99, 3, read, || unreachable!()),
        clamp_drag_rect(proposed, (2000, 400), &layout(), 99)
    );
}
