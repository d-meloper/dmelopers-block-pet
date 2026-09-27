use std::ptr::null_mut;
use windows_sys::Win32::{
    Foundation::{POINT, RECT},
    Graphics::Gdi::*,
    UI::WindowsAndMessaging::*,
};

/// A frozen physical-pixel desktop image. Never serialized, saved or sent to JS.
pub(super) struct Capture {
    pub dc: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
    pub left: i32,
    pub top: i32,
    pub width: i32,
    pub height: i32,
}

impl Capture {
    fn compatible(
        source: HDC,
        left: i32,
        top: i32,
        width: i32,
        height: i32,
    ) -> Result<Self, String> {
        unsafe {
            let mut image = Self {
                dc: CreateCompatibleDC(source),
                bitmap: null_mut(),
                previous: null_mut(),
                left,
                top,
                width,
                height,
            };
            if image.dc.is_null() || width <= 0 || height <= 0 {
                return Err("Could not allocate screen color buffer.".into());
            }
            image.bitmap = CreateCompatibleBitmap(source, width, height);
            if image.bitmap.is_null() {
                return Err("Could not allocate screen color bitmap.".into());
            }
            image.previous = SelectObject(image.dc, image.bitmap);
            if image.previous.is_null() || image.previous as isize == -1 {
                image.previous = null_mut();
                return Err("Could not select screen color bitmap.".into());
            }
            Ok(image)
        }
    }

    pub fn desktop() -> Result<Self, String> {
        unsafe {
            let screen = GetDC(null_mut());
            if screen.is_null() {
                return Err("Could not read the desktop.".into());
            }
            let result = (|| {
                let image = Self::compatible(
                    screen,
                    GetSystemMetrics(SM_XVIRTUALSCREEN),
                    GetSystemMetrics(SM_YVIRTUALSCREEN),
                    GetSystemMetrics(SM_CXVIRTUALSCREEN),
                    GetSystemMetrics(SM_CYVIRTUALSCREEN),
                )?;
                if BitBlt(
                    image.dc,
                    0,
                    0,
                    image.width,
                    image.height,
                    screen,
                    image.left,
                    image.top,
                    SRCCOPY | CAPTUREBLT,
                ) == 0
                {
                    return Err("Could not capture the desktop.".into());
                }
                Ok(image)
            })();
            ReleaseDC(null_mut(), screen);
            result
        }
    }

    pub fn colorref(&self, point: POINT) -> Result<u32, String> {
        let (x, y) = (point.x - self.left, point.y - self.top);
        if x < 0 || y < 0 || x >= self.width || y >= self.height {
            return Err("The selected pixel is outside the captured desktop.".into());
        }
        let color = unsafe { GetPixel(self.dc, x, y) };
        if color == CLR_INVALID {
            return Err("Could not read the selected pixel.".into());
        }
        Ok(color)
    }

    pub fn color(&self, point: POINT) -> Result<String, String> {
        color_hex(self.colorref(point)?)
    }

    /// A separate compositing buffer: HUD drawing never changes sampled pixels.
    pub fn duplicate(&self) -> Result<Self, String> {
        let frame = Self::compatible(self.dc, self.left, self.top, self.width, self.height)?;
        frame.restore(
            self,
            RECT {
                left: 0,
                top: 0,
                right: self.width,
                bottom: self.height,
            },
        )?;
        Ok(frame)
    }

    pub fn restore(&self, source: &Self, rect: RECT) -> Result<(), String> {
        let copied = unsafe {
            BitBlt(
                self.dc,
                rect.left,
                rect.top,
                rect.right - rect.left,
                rect.bottom - rect.top,
                source.dc,
                rect.left,
                rect.top,
                SRCCOPY,
            )
        };
        if copied == 0 {
            Err("Could not compose screen color preview.".into())
        } else {
            Ok(())
        }
    }

    #[cfg(test)]
    pub fn solid(width: i32, height: i32, color: u32) -> Self {
        unsafe {
            let screen = GetDC(null_mut());
            let image = Self::compatible(screen, 0, 0, width, height);
            ReleaseDC(null_mut(), screen);
            let image = image.unwrap();
            SetDCBrushColor(image.dc, color);
            FillRect(
                image.dc,
                &RECT {
                    left: 0,
                    top: 0,
                    right: width,
                    bottom: height,
                },
                GetStockObject(DC_BRUSH) as HBRUSH,
            );
            image
        }
    }
}

pub(super) fn color_hex(color: u32) -> Result<String, String> {
    if color == CLR_INVALID {
        return Err("Could not read the selected pixel.".into());
    }
    Ok(format!(
        "#{:02X}{:02X}{:02X}",
        color & 255,
        (color >> 8) & 255,
        (color >> 16) & 255
    ))
}

impl Drop for Capture {
    fn drop(&mut self) {
        unsafe {
            if !self.previous.is_null() {
                SelectObject(self.dc, self.previous);
            }
            if !self.bitmap.is_null() {
                DeleteObject(self.bitmap);
            }
            if !self.dc.is_null() {
                DeleteDC(self.dc);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colorref_converts_bgr_to_six_digit_rgb_and_rejects_failed_reads() {
        assert_eq!(color_hex(0x00332211).unwrap(), "#112233");
        assert_eq!(color_hex(0).unwrap(), "#000000");
        assert_eq!(color_hex(0xffffff).unwrap(), "#FFFFFF");
        assert!(color_hex(CLR_INVALID).is_err());
    }

    #[test]
    fn native_bitmap_sampling_uses_physical_offsets_and_keeps_its_original_pixels() {
        unsafe {
            let screen = GetDC(null_mut());
            assert!(!screen.is_null());
            let dc = CreateCompatibleDC(screen);
            let bitmap = CreateCompatibleBitmap(screen, 2, 2);
            ReleaseDC(null_mut(), screen);
            assert!(!dc.is_null() && !bitmap.is_null());
            let previous = SelectObject(dc, bitmap);
            let image = Capture {
                dc,
                bitmap,
                previous,
                left: -1920,
                top: -1080,
                width: 2,
                height: 2,
            };
            assert_ne!(SetPixel(dc, 1, 1, 0x00332211), CLR_INVALID);
            assert_eq!(
                image.color(POINT { x: -1919, y: -1079 }).unwrap(),
                "#112233"
            );
            assert!(image.color(POINT { x: -1921, y: -1080 }).is_err());
            assert!(image.color(POINT { x: -1918, y: -1079 }).is_err());
            let frame = image.duplicate().unwrap();
            SetPixel(frame.dc, 1, 1, 0xffffff);
            assert_eq!(
                image.color(POINT { x: -1919, y: -1079 }).unwrap(),
                "#112233"
            );
            frame
                .restore(
                    &image,
                    RECT {
                        left: 1,
                        top: 1,
                        right: 2,
                        bottom: 2,
                    },
                )
                .unwrap();
            assert_eq!(
                frame.color(POINT { x: -1919, y: -1079 }).unwrap(),
                "#112233"
            );
        }
    }
}
