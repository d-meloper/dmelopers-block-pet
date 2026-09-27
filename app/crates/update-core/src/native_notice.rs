pub fn show(reason: &str) {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONWARNING, MB_OK, MessageBoxW};
        let title: Vec<_> = "3D Block Pet — Update failed / 업데이트 실패"
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let reason = if reason.len() <= 128
            && reason
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        {
            reason
        } else {
            "RECOVERY_REQUIRED"
        };
        let message: Vec<_> = format!("Update failure: {reason}\nRecovery is not confirmed. Existing data and recovery copies have been preserved.\n\n업데이트 오류: {reason}\n복구 완료를 확인하지 못했습니다. 기존 데이터와 복구 사본을 보존했습니다.").encode_utf16().chain(Some(0)).collect();
        MessageBoxW(
            std::ptr::null_mut(),
            message.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONWARNING,
        );
    }
}
