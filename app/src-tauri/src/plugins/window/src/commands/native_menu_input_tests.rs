use super::*;
use windows::Win32::{
    Graphics::Gdi::ClientToScreen,
    UI::WindowsAndMessaging::{
        CallMsgFilterW, CreateWindowExW, DestroyWindow, WINDOW_EX_STYLE, WM_MOUSEWHEEL, WS_POPUP,
    },
};
use windows::core::w;

struct TestWindow(HWND);
impl TestWindow {
    fn new(x: i32, y: i32) -> Self {
        Self(unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                w!("STATIC"),
                None,
                WS_POPUP,
                x,
                y,
                473,
                372,
                None,
                None,
                None,
                None,
            )
            .unwrap()
        })
    }
    fn screen_point(&self, x: i32, y: i32) -> POINT {
        let mut point = POINT { x, y };
        assert!(unsafe { ClientToScreen(self.0, &mut point) }.as_bool());
        point
    }
}
impl Drop for TestWindow {
    fn drop(&mut self) {
        unsafe { DestroyWindow(self.0) }.unwrap();
    }
}

fn packed(x: i32, y: i32) -> LPARAM {
    LPARAM((u32::from(x as u16) | (u32::from(y as u16) << 16)) as isize)
}

#[test]
fn actual_failed_menu_coordinates_preserve_hover_and_both_first_click_edges() {
    let window = TestWindow::new(1192, 239);
    for kind in [WM_MOUSEMOVE, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_LBUTTONDBLCLK] {
        let point = window.screen_point(387, 389);
        let mut message = MSG {
            hwnd: window.0,
            message: kind,
            wParam: WPARAM(1),
            lParam: packed(387, 389),
            time: 74629656,
            pt: point,
        };
        normalize_mouse_coordinates(&mut message, window.0);
        assert_eq!(message.lParam, packed(point.x, point.y));
        assert_eq!(message.wParam, WPARAM(1));
        assert_eq!(message.time, 74629656);
        assert_eq!(message.pt, point);
        assert_eq!(message.message, kind);
    }
}

#[test]
fn normal_foreign_and_unrelated_messages_are_unchanged() {
    let window = TestWindow::new(1192, 239);
    let other = TestWindow::new(100, 100);
    let point = window.screen_point(387, 389);
    for (kind, hwnd, input) in [
        (WM_MOUSEMOVE, window.0, packed(point.x, point.y)),
        (WM_LBUTTONDOWN, other.0, packed(387, 389)),
        (WM_MOUSEWHEEL, window.0, packed(387, 389)),
        (WM_MOUSEMOVE, window.0, packed(1, 2)),
    ] {
        let mut message = MSG {
            hwnd,
            message: kind,
            lParam: input,
            pt: point,
            ..Default::default()
        };
        normalize_mouse_coordinates(&mut message, window.0);
        assert_eq!(message.lParam, input);
    }
    let mut outside_range = MSG {
        hwnd: window.0,
        message: WM_MOUSEMOVE,
        pt: POINT { x: 40000, y: 10 },
        lParam: packed(40000 - 1192, 10 - 239),
        ..Default::default()
    };
    let input = outside_range.lParam;
    normalize_mouse_coordinates(&mut outside_range, window.0);
    assert_eq!(outside_range.lParam, input);
}

#[test]
fn signed_coordinates_on_negative_monitor_positions_are_preserved() {
    let window = TestWindow::new(-900, -500);
    let point = window.screen_point(-10, 20);
    let mut message = MSG {
        hwnd: window.0,
        message: WM_MOUSEMOVE,
        lParam: packed(-10, 20),
        pt: point,
        ..Default::default()
    };
    normalize_mouse_coordinates(&mut message, window.0);
    assert_eq!(message.lParam.0 as i16 as i32, point.x);
    assert_eq!((message.lParam.0 >> 16) as i16 as i32, point.y);
}

#[test]
fn native_filter_owner_ends_on_success_and_failure_and_skips_ordinary_input() {
    let window = TestWindow::new(1192, 239);
    for result in [Ok(()), Err("POPUP_FAILED".to_owned())] {
        assert!(MENU_OWNER.get().is_none());
        let returned = with_menu_mouse_coordinates(window.0, || {
            assert_eq!(MENU_OWNER.get().unwrap().0, window.0);
            assert!(with_menu_mouse_coordinates(window.0, || panic!("nested owner")).is_err());
            let mut message = MSG {
                hwnd: window.0,
                message: WM_MOUSEMOVE,
                lParam: packed(387, 389),
                pt: window.screen_point(387, 389),
                ..Default::default()
            };
            // An installed native hook must not alter messages outside popup tracking.
            assert!(!unsafe { CallMsgFilterW(&mut message, MSGF_MENU as i32) }.as_bool());
            assert_eq!(message.lParam, packed(387, 389));
            result.clone()
        });
        assert_eq!(returned, result);
        assert!(MENU_OWNER.get().is_none());
    }
}

#[test]
fn handled_filter_chain_and_non_menu_calls_are_preserved() {
    unsafe extern "system" fn handled(_: i32, _: WPARAM, _: LPARAM) -> LRESULT {
        LRESULT(1)
    }
    let window = TestWindow::new(1192, 239);
    let other = unsafe {
        SetWindowsHookExW(
            WH_MSGFILTER,
            Some(handled),
            None,
            GetWindowThreadProcessId(window.0, None),
        )
    }
    .unwrap();
    with_menu_mouse_coordinates(window.0, || {
        for code in [MSGF_MENU as i32, 0] {
            let mut message = MSG {
                hwnd: window.0,
                message: WM_MOUSEMOVE,
                lParam: packed(387, 389),
                pt: window.screen_point(387, 389),
                ..Default::default()
            };
            assert!(unsafe { CallMsgFilterW(&mut message, code) }.as_bool());
            assert_eq!(message.lParam, packed(387, 389));
        }
        Ok(())
    })
    .unwrap();
    unsafe { UnhookWindowsHookEx(other) }.unwrap();
}
