//! Bounded message transport for the one authenticated administrator input peer.
use crate::windows_process::Handle;
use serde::{Serialize, de::DeserializeOwned};
use std::sync::{Arc, Mutex};
use windows_sys::Win32::{
    Foundation::{ERROR_IO_PENDING, GetLastError, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT},
    Storage::FileSystem::{ReadFile, WriteFile},
    System::{
        IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED},
        Pipes::{PIPE_READMODE_MESSAGE, SetNamedPipeHandleState},
        Threading::{
            CreateEventW, INFINITE, SetEvent, WaitForMultipleObjects, WaitForSingleObject,
        },
    },
};

pub(super) const MAXIMUM_FRAME: usize = 4096;
const WRITE_TIMEOUT_MS: u32 = 10_000;
const MAXIMUM_EXIT_WAIT_MS: u32 = 5_000;
const FAILURE: &str = "ELEVATION_HANDOFF_FAILED";

struct Inner {
    pipe: Handle,
    peer: Handle,
    cancel: Handle,
    reader: Mutex<()>,
    writer: Mutex<()>,
}
// Kernel handles permit concurrent waits and one overlapped operation in each
// direction. The independent direction locks keep buffers/frames from mixing.
unsafe impl Sync for Inner {}
impl Drop for Inner {
    fn drop(&mut self) {
        unsafe {
            SetEvent(self.cancel.0);
            CancelIoEx(self.pipe.0, std::ptr::null());
        }
    }
}

#[derive(Clone)]
pub(crate) struct Transport(Arc<Inner>);
impl std::fmt::Debug for Transport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AdministratorInputTransport")
            .field("alive", &self.alive())
            .finish()
    }
}

impl Transport {
    pub(super) fn peer_handle(&self) -> HANDLE {
        self.0.peer.0
    }

    pub(super) fn cancel_handle(&self) -> HANDLE {
        self.0.cancel.0
    }

    pub(super) fn new(pipe: Handle, peer: Handle, cancel: Handle) -> Result<Self, String> {
        // CreateFile opens a pipe client in byte-read mode by default. Both ends
        // must preserve message boundaries rather than accept partial JSON.
        let mode = PIPE_READMODE_MESSAGE;
        if unsafe { SetNamedPipeHandleState(pipe.0, &mode, std::ptr::null(), std::ptr::null()) }
            == 0
        {
            unsafe { SetEvent(cancel.0) };
            return Err(FAILURE.into());
        }
        Ok(Self(Arc::new(Inner {
            pipe,
            peer,
            cancel,
            reader: Mutex::new(()),
            writer: Mutex::new(()),
        })))
    }

    pub(crate) fn alive(&self) -> bool {
        unsafe {
            WaitForSingleObject(self.0.cancel.0, 0) == WAIT_TIMEOUT
                && WaitForSingleObject(self.0.peer.0, 0) == WAIT_TIMEOUT
        }
    }

    pub(crate) fn cancel(&self) {
        unsafe {
            SetEvent(self.0.cancel.0);
            CancelIoEx(self.0.pipe.0, std::ptr::null());
        }
    }

    /// Cancellation is only a request. Verify this exact authenticated process
    /// has actually exited before reporting that administrator input is stopped.
    pub(crate) fn wait_for_peer_exit(&self, timeout_ms: u32) -> Result<(), String> {
        wait_for_process_exit(self.0.peer.0, timeout_ms)
    }

    pub(crate) fn send<T: Serialize>(&self, value: &T) -> Result<(), String> {
        let bytes = encode_frame(value)?;
        let _writer = self.0.writer.lock().map_err(|_| FAILURE.to_owned())?;
        let transferred = self.operation(WRITE_TIMEOUT_MS, |overlapped| unsafe {
            WriteFile(
                self.0.pipe.0,
                bytes.as_ptr(),
                bytes.len() as u32,
                std::ptr::null_mut(),
                overlapped,
            )
        })?;
        if transferred as usize != bytes.len() {
            self.cancel();
            return Err(FAILURE.into());
        }
        Ok(())
    }

    pub(crate) fn receive<T: DeserializeOwned>(&self) -> Result<T, String> {
        self.receive_for(INFINITE)
    }

    pub(super) fn receive_for<T: DeserializeOwned>(&self, timeout_ms: u32) -> Result<T, String> {
        let _reader = self.0.reader.lock().map_err(|_| FAILURE.to_owned())?;
        let mut bytes = vec![0u8; MAXIMUM_FRAME];
        let transferred = self.operation(timeout_ms, |overlapped| unsafe {
            ReadFile(
                self.0.pipe.0,
                bytes.as_mut_ptr(),
                bytes.len() as u32,
                std::ptr::null_mut(),
                overlapped,
            )
        })?;
        bytes.truncate(transferred as usize);
        decode_frame(&bytes).inspect_err(|_| self.cancel())
    }

    fn operation(
        &self,
        timeout_ms: u32,
        begin: impl FnOnce(*mut OVERLAPPED) -> i32,
    ) -> Result<u32, String> {
        if !self.alive() {
            return Err(FAILURE.into());
        }
        let raw = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
        if raw.is_null() {
            return Err(FAILURE.into());
        }
        let event = Handle(raw);
        let mut overlapped = OVERLAPPED {
            hEvent: event.0,
            ..Default::default()
        };
        if begin(&mut overlapped) == 0 {
            let error = unsafe { GetLastError() };
            if error != ERROR_IO_PENDING {
                self.cancel();
                return Err(FAILURE.into());
            }
            let waits: [HANDLE; 3] = [event.0, self.0.cancel.0, self.0.peer.0];
            if unsafe { WaitForMultipleObjects(3, waits.as_ptr(), 0, timeout_ms) } != WAIT_OBJECT_0
            {
                // The operation owns stack OVERLAPPED/buffer memory. Always
                // cancel and drain its completion before that memory is freed.
                unsafe {
                    CancelIoEx(self.0.pipe.0, &overlapped);
                    let mut drained = 0;
                    GetOverlappedResult(self.0.pipe.0, &overlapped, &mut drained, 1);
                }
                self.cancel();
                return Err(FAILURE.into());
            }
        }
        let mut transferred = 0;
        if unsafe { GetOverlappedResult(self.0.pipe.0, &overlapped, &mut transferred, 0) } == 0 {
            self.cancel();
            return Err(FAILURE.into());
        }
        Ok(transferred)
    }
}

fn wait_for_process_exit(peer: HANDLE, timeout_ms: u32) -> Result<(), String> {
    let result = unsafe { WaitForSingleObject(peer, timeout_ms.min(MAXIMUM_EXIT_WAIT_MS)) };
    peer_exit_result(result)
}

fn peer_exit_result(result: u32) -> Result<(), String> {
    if result == WAIT_OBJECT_0 {
        Ok(())
    } else {
        Err("ELEVATION_CHILD_NOT_READY".into())
    }
}

fn encode_frame<T: Serialize>(value: &T) -> Result<Vec<u8>, String> {
    let bytes = serde_json::to_vec(value).map_err(|_| FAILURE.to_owned())?;
    if bytes.is_empty() || bytes.len() > MAXIMUM_FRAME {
        return Err(FAILURE.into());
    }
    Ok(bytes)
}

fn decode_frame<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, String> {
    if bytes.is_empty() || bytes.len() > MAXIMUM_FRAME {
        return Err(FAILURE.into());
    }
    serde_json::from_slice(bytes).map_err(|_| FAILURE.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Frame {
        active: bool,
    }

    #[test]
    fn frames_are_bounded_and_reject_unknown_fields_or_malformed_json() {
        let value = Frame { active: true };
        assert_eq!(
            decode_frame::<Frame>(&encode_frame(&value).unwrap()).unwrap(),
            value
        );
        for bytes in [
            b"".as_slice(),
            b"{",
            br#"{"active":true,"program":"cmd.exe"}"#,
        ] {
            assert!(decode_frame::<Frame>(bytes).is_err());
        }
        assert!(decode_frame::<serde_json::Value>(&vec![b' '; MAXIMUM_FRAME + 1]).is_err());
        assert!(encode_frame(&"a".repeat(MAXIMUM_FRAME)).is_err());
    }

    #[test]
    fn only_confirmed_peer_exit_is_successful() {
        use windows_sys::Win32::Foundation::{WAIT_ABANDONED_0, WAIT_FAILED};
        assert!(peer_exit_result(WAIT_OBJECT_0).is_ok());
        for result in [
            WAIT_TIMEOUT,
            WAIT_FAILED,
            WAIT_ABANDONED_0,
            WAIT_OBJECT_0 + 1,
        ] {
            assert_eq!(
                peer_exit_result(result),
                Err("ELEVATION_CHILD_NOT_READY".into())
            );
        }
    }

    #[test]
    fn bounded_peer_wait_confirms_an_actual_child_process_exit() {
        use std::{
            ffi::OsString,
            os::windows::{ffi::OsStringExt, io::AsRawHandle, process::CommandExt},
            path::PathBuf,
            process::{Command, Stdio},
        };
        use windows_sys::Win32::System::{
            SystemInformation::GetSystemDirectoryW, Threading::CREATE_NO_WINDOW,
        };
        let mut directory = vec![0u16; 32_768];
        let count =
            unsafe { GetSystemDirectoryW(directory.as_mut_ptr(), directory.len() as u32) } as usize;
        assert!(count > 0 && count < directory.len());
        let system = PathBuf::from(OsString::from_wide(&directory[..count]));
        // Absolute OS command; /d disables registry AutoRun commands. This test
        // starts no application UI and touches no account or application data.
        let mut child = Command::new(system.join("cmd.exe"))
            .current_dir(&system)
            .args(["/d", "/q", "/c", "exit", "0"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("start the test-owned immediate-exit OS child");
        let waited = wait_for_process_exit(child.as_raw_handle(), MAXIMUM_EXIT_WAIT_MS);
        if waited.is_err() {
            // Failure cleanup applies only to this test-owned utility process.
            // Production worker shutdown never uses process termination.
            let _ = child.kill();
            assert!(
                wait_for_process_exit(child.as_raw_handle(), MAXIMUM_EXIT_WAIT_MS).is_ok(),
                "the test-owned child could not be cleaned up within its bounded wait"
            );
        }
        // The Win32 wait has confirmed exit, so reaping cannot block on a live child.
        let status = child.wait().expect("reap the exact test child");
        assert!(
            waited.is_ok(),
            "bounded peer wait did not observe child exit: {waited:?}"
        );
        assert!(status.success());
    }
}
