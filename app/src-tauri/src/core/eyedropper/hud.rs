use serde::Deserialize;
use std::ptr::null_mut;
use windows_sys::Win32::{
    Foundation::{POINT, RECT},
    Graphics::Gdi::*,
};

/// Resolved app theme tokens, already blended to opaque Win32 COLORREF values.
#[derive(Clone, Copy, Deserialize)]
pub struct Appearance {
    pub background: u32,
    pub border: u32,
    pub muted: u32,
}

impl Appearance {
    pub fn valid(&self) -> bool {
        [self.background, self.border, self.muted]
            .into_iter()
            .all(|color| color <= 0xffffff)
    }
}

impl Default for Appearance {
    fn default() -> Self {
        // Compatibility for older callers; current callers pass live app tokens.
        Self {
            background: 0xffffff,
            border: 0xdae6d6,
            muted: 0x737373,
        }
    }
}

pub(super) struct Hud {
    scale: f64,
    appearance: Appearance,
    font: HFONT,
    instruction: Vec<u16>,
}

impl Hud {
    pub fn new(appearance: Appearance, instruction: &str, dpi: u32) -> Result<Self, String> {
        let mut hud = Self {
            scale: f64::from(dpi.max(96)) / 96.0,
            appearance,
            font: null_mut(),
            instruction: instruction.encode_utf16().collect(),
        };
        let face: Vec<u16> = "Segoe UI".encode_utf16().chain(Some(0)).collect();
        hud.font = unsafe {
            CreateFontW(
                -hud.px(12),
                0,
                0,
                0,
                FW_NORMAL as i32,
                0,
                0,
                0,
                DEFAULT_CHARSET as u32,
                OUT_DEFAULT_PRECIS as u32,
                CLIP_DEFAULT_PRECIS as u32,
                CLEARTYPE_QUALITY as u32,
                DEFAULT_PITCH as u32,
                face.as_ptr(),
            )
        };
        if hud.font.is_null() {
            return Err("Could not prepare color preview text.".into());
        }
        Ok(hud)
    }

    fn px(&self, value: i32) -> i32 {
        (f64::from(value) * self.scale).round() as i32
    }

    pub fn bounds(&self, cursor: POINT, monitor: RECT) -> RECT {
        place_hint(cursor, monitor, self.px(212), self.px(244), self.px(24))
    }

    /// Draw only into the memory frame. WM_PAINT presents the completed frame once.
    pub fn draw(&self, dc: HDC, bounds: RECT, color: u32) -> Result<(), String> {
        unsafe {
            let saved = SaveDC(dc);
            if saved == 0 {
                return Err("Could not prepare color preview drawing.".into());
            }
            SelectObject(dc, GetStockObject(DC_BRUSH));
            SelectObject(dc, GetStockObject(DC_PEN));
            let x = bounds.left;
            let y = bounds.top;
            let panel = RECT {
                left: x + self.px(4),
                top: y + self.px(4),
                right: bounds.right - self.px(4),
                bottom: bounds.bottom - self.px(8),
            };
            // A restrained, tinted edge/shadow matches the app's elevated cards.
            rounded(
                dc,
                RECT {
                    left: panel.left,
                    top: panel.top + self.px(3),
                    right: panel.right,
                    bottom: panel.bottom + self.px(3),
                },
                self.px(12),
                self.appearance.border,
                self.appearance.border,
            );
            rounded(
                dc,
                panel,
                self.px(12),
                self.appearance.background,
                self.appearance.border,
            );
            let swatch = RECT {
                left: panel.left + self.px(14),
                top: panel.top + self.px(14),
                right: panel.right - self.px(14),
                bottom: panel.top + self.px(190),
            };
            rounded(dc, swatch, self.px(8), color, self.appearance.border);
            SetBkMode(dc, TRANSPARENT as i32);
            SelectObject(dc, self.font);
            SetTextColor(dc, self.appearance.muted);
            let mut line = RECT {
                left: swatch.left,
                top: swatch.bottom + self.px(10),
                right: swatch.right,
                bottom: panel.bottom - self.px(10),
            };
            DrawTextW(
                dc,
                self.instruction.as_ptr(),
                self.instruction.len() as i32,
                &mut line,
                DT_CENTER | DT_SINGLELINE | DT_VCENTER | DT_NOPREFIX | DT_END_ELLIPSIS,
            );
            RestoreDC(dc, saved);
        }
        Ok(())
    }
}

impl Drop for Hud {
    fn drop(&mut self) {
        if !self.font.is_null() {
            unsafe {
                DeleteObject(self.font);
            }
        }
    }
}

unsafe fn rounded(dc: HDC, rect: RECT, radius: i32, fill: u32, border: u32) {
    unsafe {
        SetDCBrushColor(dc, fill);
        SetDCPenColor(dc, border);
        RoundRect(
            dc,
            rect.left,
            rect.top,
            rect.right,
            rect.bottom,
            radius * 2,
            radius * 2,
        );
    }
}

/// Flip to the other side at an edge, then keep the entire card on that monitor.
fn place_hint(cursor: POINT, monitor: RECT, width: i32, height: i32, gap: i32) -> RECT {
    let width = width.min((monitor.right - monitor.left).max(1));
    let height = height.min((monitor.bottom - monitor.top).max(1));
    let left = if cursor.x + gap + width <= monitor.right {
        cursor.x + gap
    } else {
        cursor.x - gap - width
    };
    let top = if cursor.y + gap + height <= monitor.bottom {
        cursor.y + gap
    } else {
        cursor.y - gap - height
    };
    let left = left.clamp(monitor.left, monitor.right - width);
    let top = top.clamp(monitor.top, monitor.bottom - height);
    RECT {
        left,
        top,
        right: left + width,
        bottom: top + height,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn card_stays_on_selected_monitor_at_edges_and_scaled_negative_coordinates() {
        let monitor = RECT {
            left: -2560,
            top: -1440,
            right: 0,
            bottom: 0,
        };
        for point in [
            POINT { x: -2560, y: -1440 },
            POINT { x: -1, y: -1 },
            POINT { x: -1280, y: -720 },
        ] {
            for scale in [1, 2, 3] {
                let rect = place_hint(point, monitor, 212 * scale, 244 * scale, 24 * scale);
                assert!(rect.left >= monitor.left && rect.right <= monitor.right);
                assert!(rect.top >= monitor.top && rect.bottom <= monitor.bottom);
                assert!(
                    !(point.x >= rect.left
                        && point.x < rect.right
                        && point.y >= rect.top
                        && point.y < rect.bottom)
                );
            }
        }
    }

    #[test]
    fn native_theme_accepts_only_opaque_colorrefs() {
        assert!(Appearance::default().valid());
        assert!(
            !Appearance {
                border: 0x1000000,
                ..Appearance::default()
            }
            .valid()
        );
    }

    #[test]
    fn native_card_contains_the_exact_swatch_and_clears_without_touching_the_sample_image() {
        use super::super::capture::Capture;
        let background = 0xbbaa99;
        for appearance in [
            Appearance::default(),
            Appearance {
                background: 0x1b2419,
                border: 0x3a4635,
                muted: 0xbbbbbb,
            },
        ] {
            for color in [0, 0xffffff, 0x6da73a] {
                let image = Capture::solid(720, 360, background);
                let frame = image.duplicate().unwrap();
                let hud = Hud::new(appearance, "클릭: 선택 · Esc: 취소", 96).unwrap();
                let bounds = RECT {
                    left: 12,
                    top: 12,
                    right: 224,
                    bottom: 256,
                };
                hud.draw(frame.dc, bounds, color).unwrap();
                // A large uninterrupted preview occupies the upper card.
                for point in [
                    POINT { x: 40, y: 40 },
                    POINT { x: 118, y: 118 },
                    POINT { x: 196, y: 196 },
                ] {
                    assert_eq!(frame.colorref(point).unwrap(), color);
                }
                assert_eq!(
                    frame.colorref(POINT { x: 22, y: 230 }).unwrap(),
                    appearance.background
                );
                assert_eq!(frame.colorref(POINT { x: 12, y: 12 }).unwrap(), background);
                // Sampling always reads the pristine image even over the displayed card.
                assert_eq!(image.colorref(POINT { x: 54, y: 58 }).unwrap(), background);
                frame.restore(&image, bounds).unwrap();
                for x in 0..240 {
                    for y in 0..270 {
                        assert_eq!(frame.colorref(POINT { x, y }).unwrap(), background);
                    }
                }
            }
        }
    }
}
