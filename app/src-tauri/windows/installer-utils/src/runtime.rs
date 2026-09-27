//! Runtime subset from the retained nsis-plugin-api 0.5.3 source.
//! Keep the upstream files unchanged; use the Windows BOOL ABI for DllMain.

#[no_mangle]
extern "system" fn DllMain(
    _: windows_sys::Win32::Foundation::HINSTANCE,
    _: u32,
    _: *mut core::ffi::c_void,
) -> i32 {
    windows_sys::Win32::Foundation::TRUE
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    unsafe { windows_sys::Win32::System::Threading::ExitProcess(u32::MAX) }
}

#[no_mangle]
pub unsafe extern "C" fn memcpy(dest: *mut u8, src: *const u8, n: isize) -> *mut u8 {
    let mut i = 0;
    while i < n {
        *dest.offset(i) = *src.offset(i);
        i += 1;
    }
    dest
}

#[no_mangle]
pub unsafe extern "C" fn memcmp(left: *const u8, right: *const u8, n: isize) -> i32 {
    let mut i = 0;
    while i < n {
        let a = *left.offset(i);
        let b = *right.offset(i);
        if a != b {
            return a as i32 - b as i32;
        }
        i += 1;
    }
    0
}

#[no_mangle]
pub unsafe extern "C" fn memset(dest: *mut u8, value: i32, n: isize) -> *mut u8 {
    let mut i = 0;
    while i < n {
        *dest.offset(i) = value as u8;
        i += 1;
    }
    dest
}
