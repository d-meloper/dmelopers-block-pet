//! Private resident bytes for exactly the selected application process tree.
use super::PerformanceUnavailableReason;
use std::io;
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE},
    System::{
        ProcessStatus::{
            GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX2,
        },
        Threading::{OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ},
    },
};

struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

fn private_working_set(pid: u32) -> io::Result<u64> {
    let raw = unsafe { OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid) };
    if raw.is_null() {
        return Err(io::Error::last_os_error());
    }
    let handle = Handle(raw);
    let size = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX2>() as u32;
    let mut counters: PROCESS_MEMORY_COUNTERS_EX2 = unsafe { std::mem::zeroed() };
    counters.cb = size;
    // An older implementation may accept the prefix but not fill the EX2 field.
    // Never mistake that unsupported reading for zero or substitute total WS.
    counters.PrivateWorkingSetSize = usize::MAX;
    if unsafe {
        GetProcessMemoryInfo(
            handle.0,
            (&mut counters as *mut PROCESS_MEMORY_COUNTERS_EX2).cast::<PROCESS_MEMORY_COUNTERS>(),
            size,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    if counters.PrivateWorkingSetSize == usize::MAX
        || counters.PrivateWorkingSetSize > counters.WorkingSetSize
    {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Private working set is unavailable.",
        ));
    }
    Ok(counters.PrivateWorkingSetSize as u64)
}

fn sum_private_working_sets(
    ids: impl IntoIterator<Item = u32>,
    mut read: impl FnMut(u32) -> io::Result<u64>,
) -> io::Result<u64> {
    let mut total = 0_u64;
    for pid in ids {
        total = total.checked_add(read(pid)?).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "Private working set overflowed.",
            )
        })?;
    }
    Ok(total)
}

pub(super) fn sample(ids: impl IntoIterator<Item = u32>) -> io::Result<u64> {
    sum_private_working_sets(ids, private_working_set)
}

pub(super) fn unavailable_reason(error: &io::Error) -> PerformanceUnavailableReason {
    match error.kind() {
        io::ErrorKind::PermissionDenied => PerformanceUnavailableReason::AccessDenied,
        io::ErrorKind::NotFound => PerformanceUnavailableReason::ProcessUnavailable,
        io::ErrorKind::Unsupported => PerformanceUnavailableReason::Unsupported,
        io::ErrorKind::InvalidData => PerformanceUnavailableReason::InvalidSample,
        // OpenProcess/GetProcessMemoryInfo failed, but the observed code does
        // not establish a particular permission, process or OS explanation.
        _ => PerformanceUnavailableReason::CounterReadFailed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_test_process_private_working_set_with_the_actual_windows_api() {
        let bytes = private_working_set(std::process::id())
            .expect("EX2 private working set on the supported Windows version");
        assert!(bytes > 0);
    }

    #[test]
    fn sums_only_selected_private_resident_bytes_and_keeps_real_zero() {
        let mut visited = Vec::new();
        let result = sum_private_working_sets([11, 17, 23], |pid| {
            visited.push(pid);
            Ok(match pid {
                11 => 14,
                17 => 0,
                23 => 362,
                _ => panic!("unrelated process"),
            })
        })
        .unwrap();
        assert_eq!(visited, [11, 17, 23]);
        assert_eq!(result, 376);
        assert_eq!(sum_private_working_sets([11], |_| Ok(0)).unwrap(), 0);
    }

    #[test]
    fn missing_denied_or_unsupported_children_invalidate_the_whole_ram_sample() {
        for kind in [
            io::ErrorKind::NotFound,
            io::ErrorKind::PermissionDenied,
            io::ErrorKind::Unsupported,
        ] {
            let result = sum_private_working_sets([11, 17], |pid| {
                if pid == 11 {
                    Ok(100)
                } else {
                    Err(io::Error::from(kind))
                }
            });
            assert_eq!(result.unwrap_err().kind(), kind);
        }
        assert!(sum_private_working_sets([11, 17], |_| Ok(u64::MAX)).is_err());
    }

    #[test]
    fn unavailable_reasons_report_only_the_observed_error_class() {
        for (kind, reason) in [
            (
                io::ErrorKind::PermissionDenied,
                PerformanceUnavailableReason::AccessDenied,
            ),
            (
                io::ErrorKind::NotFound,
                PerformanceUnavailableReason::ProcessUnavailable,
            ),
            (
                io::ErrorKind::Unsupported,
                PerformanceUnavailableReason::Unsupported,
            ),
            (
                io::ErrorKind::InvalidData,
                PerformanceUnavailableReason::InvalidSample,
            ),
            (
                io::ErrorKind::Other,
                PerformanceUnavailableReason::CounterReadFailed,
            ),
        ] {
            assert_eq!(unavailable_reason(&io::Error::from(kind)), reason);
        }
    }
}
