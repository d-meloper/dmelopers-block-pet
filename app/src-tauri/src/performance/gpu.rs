use super::{MetricReading, PerformanceUnavailableReason};
use std::{collections::HashSet, time::Instant};

const GPU_RETRY_DELAY: std::time::Duration = std::time::Duration::from_secs(30);

pub(super) struct GpuMonitor {
    query: Option<windows::PdhGpuQuery>,
    retry_at: Option<Instant>,
    failure_reason: Option<PerformanceUnavailableReason>,
}

impl GpuMonitor {
    pub(super) fn new() -> Self {
        Self {
            query: None,
            retry_at: None,
            failure_reason: None,
        }
    }

    pub(super) fn prime(&mut self) {
        let now = Instant::now();
        if !self.ensure_query(now) {
            return;
        }

        if let Some(query) = self.query.as_mut()
            && let Err(reason) = query.prime()
        {
            self.mark_failed(now, reason);
        }
    }

    pub(super) fn sample(&mut self, process_ids: &HashSet<u32>) -> MetricReading<f32> {
        let now = Instant::now();
        if !self.ensure_query(now) {
            return MetricReading::unavailable(
                self.failure_reason
                    .unwrap_or(PerformanceUnavailableReason::CounterUnavailable),
            );
        }

        match self
            .query
            .as_mut()
            .expect("GPU query must exist after ensure_query")
            .sample(process_ids)
        {
            Ok(value) => value,
            Err(reason) => {
                self.mark_failed(now, reason);
                MetricReading::unavailable(reason)
            }
        }
    }

    fn ensure_query(&mut self, now: Instant) -> bool {
        if self.query.is_some() {
            return true;
        }
        if self.retry_at.is_some_and(|retry_at| now < retry_at) {
            return false;
        }

        match windows::PdhGpuQuery::open() {
            Ok(query) => {
                self.query = Some(query);
                self.retry_at = None;
                self.failure_reason = None;
                true
            }
            Err(reason) => {
                self.mark_failed(now, reason);
                false
            }
        }
    }

    fn mark_failed(&mut self, now: Instant, reason: PerformanceUnavailableReason) {
        self.query = None;
        self.retry_at = Some(now + GPU_RETRY_DELAY);
        self.failure_reason = Some(reason);
    }
}

fn parse_gpu_engine_instance(instance_name: &str) -> Option<(u32, &str)> {
    let remainder = instance_name.strip_prefix("pid_")?;
    let (pid, engine_suffix) = remainder.split_once("_luid_")?;
    if engine_suffix.is_empty() {
        return None;
    }
    Some((pid.parse().ok()?, engine_suffix))
}

#[cfg(test)]
pub(super) fn aggregate_gpu_engine_usage<'a>(
    samples: impl IntoIterator<Item = (&'a str, Option<f64>)>,
    process_ids: &HashSet<u32>,
) -> Option<f32> {
    aggregate_gpu_engine_usage_with_reason(
        samples.into_iter().map(|(instance_name, utilization)| {
            (
                instance_name,
                utilization.ok_or(PerformanceUnavailableReason::InvalidSample),
            )
        }),
        process_ids,
    )
    .ok()
}

fn aggregate_gpu_engine_usage_with_reason<'a>(
    samples: impl IntoIterator<Item = (&'a str, Result<f64, PerformanceUnavailableReason>)>,
    process_ids: &HashSet<u32>,
) -> Result<f32, PerformanceUnavailableReason> {
    let mut recognized_sample = false;
    let mut engine_totals = std::collections::HashMap::<&str, f64>::new();

    for (instance_name, utilization) in samples {
        let Some((pid, engine_key)) = parse_gpu_engine_instance(instance_name) else {
            continue;
        };
        let utilization = utilization.and_then(|value| {
            if value.is_finite() && value >= 0.0 {
                Ok(value)
            } else {
                Err(PerformanceUnavailableReason::InvalidSample)
            }
        });
        if process_ids.contains(&pid) {
            // An invalid app-owned counter means an unknown total, even when
            // other applications or engines have valid data. It is never idle.
            *engine_totals.entry(engine_key).or_default() += utilization?;
        } else if utilization.is_err() {
            continue;
        }
        recognized_sample = true;
    }

    if !recognized_sample {
        return Err(PerformanceUnavailableReason::CounterUnavailable);
    }

    Ok(engine_totals
        .into_values()
        .map(|value| value.clamp(0.0, 100.0))
        .fold(0.0_f64, f64::max) as f32)
}

mod windows {
    use std::{collections::HashSet, ffi::c_void, mem, ptr, slice};

    use windows_sys::{
        Win32::System::Performance::{
            PDH_ACCESS_DENIED, PDH_CSTATUS_INVALID_DATA, PDH_CSTATUS_NEW_DATA,
            PDH_CSTATUS_NO_COUNTER, PDH_CSTATUS_NO_INSTANCE, PDH_CSTATUS_NO_OBJECT,
            PDH_CSTATUS_VALID_DATA, PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE, PDH_HCOUNTER,
            PDH_HQUERY, PDH_INVALID_DATA, PDH_MORE_DATA, PDH_NO_DATA, PdhAddEnglishCounterW,
            PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW, PdhOpenQueryW,
        },
        w,
    };

    use super::{
        MetricReading, PerformanceUnavailableReason, aggregate_gpu_engine_usage_with_reason,
    };

    fn pdh_unavailable_reason(status: u32) -> PerformanceUnavailableReason {
        match status {
            PDH_ACCESS_DENIED | windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED => {
                PerformanceUnavailableReason::AccessDenied
            }
            PDH_CSTATUS_NO_OBJECT
            | PDH_CSTATUS_NO_COUNTER
            | PDH_CSTATUS_NO_INSTANCE
            | PDH_NO_DATA => PerformanceUnavailableReason::CounterUnavailable,
            PDH_CSTATUS_INVALID_DATA | PDH_INVALID_DATA => {
                PerformanceUnavailableReason::InvalidSample
            }
            // A failed PDH call establishes a read failure, not its environmental cause.
            _ => PerformanceUnavailableReason::CounterReadFailed,
        }
    }

    const MAX_COUNTER_BUFFER_BYTES: usize = 16 * 1024 * 1024;
    const MAX_INSTANCE_NAME_UNITS: usize = 4096;

    pub(super) struct PdhGpuQuery {
        query: usize,
        counter: usize,
        primed: bool,
    }

    impl PdhGpuQuery {
        pub(super) fn open() -> Result<Self, PerformanceUnavailableReason> {
            let mut query: PDH_HQUERY = ptr::null_mut();
            // SAFETY: PDH initializes the out handle and receives a null data-source pointer.
            let status = unsafe { PdhOpenQueryW(ptr::null(), 0, &mut query) };
            if status != 0 {
                crate::diagnostics::warn("performance.gpu_open", &format!("PDH_0x{status:08X}"));
                return Err(pdh_unavailable_reason(status));
            }

            let mut counter: PDH_HCOUNTER = ptr::null_mut();
            // PdhAddEnglishCounterW keeps the wildcard while translating the object and counter
            // names for the current Windows locale. The formatted-array API returns its matching
            // instances after each collection.
            let status = unsafe {
                PdhAddEnglishCounterW(
                    query,
                    w!("\\GPU Engine(*)\\Utilization Percentage"),
                    0,
                    &mut counter,
                )
            };
            if status != 0 {
                crate::diagnostics::warn("performance.gpu_counter", &format!("PDH_0x{status:08X}"));
                // SAFETY: query was opened successfully and is owned by this scope.
                unsafe { PdhCloseQuery(query) };
                return Err(pdh_unavailable_reason(status));
            }

            Ok(Self {
                query: query as usize,
                counter: counter as usize,
                primed: false,
            })
        }

        pub(super) fn prime(&mut self) -> Result<(), PerformanceUnavailableReason> {
            self.collect()?;
            self.primed = true;
            Ok(())
        }

        pub(super) fn sample(
            &mut self,
            process_ids: &HashSet<u32>,
        ) -> Result<MetricReading<f32>, PerformanceUnavailableReason> {
            self.collect()?;
            if !self.primed {
                self.primed = true;
                return Ok(MetricReading::unavailable(
                    PerformanceUnavailableReason::Initializing,
                ));
            }

            let samples = self.formatted_samples()?;
            Ok(MetricReading::from_result(
                aggregate_gpu_engine_usage_with_reason(
                    samples.iter().map(|sample| {
                        (
                            sample.instance_name.as_str(),
                            sample.utilization.ok_or(
                                sample
                                    .unavailable_reason
                                    .unwrap_or(PerformanceUnavailableReason::InvalidSample),
                            ),
                        )
                    }),
                    process_ids,
                ),
            ))
        }

        fn collect(&self) -> Result<(), PerformanceUnavailableReason> {
            // SAFETY: the query handle remains valid for the lifetime of this wrapper.
            match unsafe { PdhCollectQueryData(self.query as PDH_HQUERY) } {
                0 => Ok(()),
                status => {
                    crate::diagnostics::warn(
                        "performance.gpu_collect",
                        &format!("PDH_0x{status:08X}"),
                    );
                    Err(pdh_unavailable_reason(status))
                }
            }
        }

        fn formatted_samples(&self) -> Result<Vec<FormattedSample>, PerformanceUnavailableReason> {
            formatted_samples_with(
                |buffer_size, item_count, buffer| {
                    // SAFETY: the counter remains live, and the helper supplies either a null
                    // sizing buffer or aligned storage of at least the requested size.
                    unsafe {
                        PdhGetFormattedCounterArrayW(
                            self.counter as PDH_HCOUNTER,
                            PDH_FMT_DOUBLE,
                            buffer_size,
                            item_count,
                            buffer,
                        )
                    }
                },
                |operation, code| crate::diagnostics::warn(operation, code),
            )
        }
    }

    fn formatted_samples_with(
        mut query: impl FnMut(&mut u32, &mut u32, *mut PDH_FMT_COUNTERVALUE_ITEM_W) -> u32,
        mut report: impl FnMut(&'static str, &str),
    ) -> Result<Vec<FormattedSample>, PerformanceUnavailableReason> {
        for _ in 0..3 {
            let mut buffer_size = 0_u32;
            let mut item_count = 0_u32;
            // SAFETY: a null output buffer with valid size/count pointers is PDH's size query.
            let first_status = query(&mut buffer_size, &mut item_count, ptr::null_mut());
            if first_status == 0 && item_count == 0 {
                return Ok(Vec::new());
            }
            if first_status != PDH_MORE_DATA {
                report(
                    "performance.gpu_sample_size",
                    &format!("PDH_0x{first_status:08X}"),
                );
                return Err(pdh_unavailable_reason(first_status));
            }

            let required_bytes = buffer_size as usize;
            if required_bytes == 0 || required_bytes > MAX_COUNTER_BUFFER_BYTES {
                report("performance.gpu_sample_size", "PDH_BUFFER_INVALID");
                return Err(PerformanceUnavailableReason::InvalidSample);
            }
            let word_count = required_bytes.div_ceil(mem::size_of::<usize>());
            let mut storage = vec![0_usize; word_count];

            // SAFETY: storage is aligned and at least buffer_size bytes long, as calculated above.
            let second_status = query(
                &mut buffer_size,
                &mut item_count,
                storage.as_mut_ptr().cast::<PDH_FMT_COUNTERVALUE_ITEM_W>(),
            );
            if second_status == PDH_MORE_DATA {
                continue;
            }
            if second_status != 0 {
                report(
                    "performance.gpu_sample",
                    &format!("PDH_0x{second_status:08X}"),
                );
                return Err(pdh_unavailable_reason(second_status));
            }

            let Some(storage_bytes) = storage.len().checked_mul(mem::size_of::<usize>()) else {
                report("performance.gpu_sample", "PDH_BUFFER_INVALID");
                return Err(PerformanceUnavailableReason::InvalidSample);
            };
            let Some(item_bytes) =
                (item_count as usize).checked_mul(mem::size_of::<PDH_FMT_COUNTERVALUE_ITEM_W>())
            else {
                report("performance.gpu_sample", "PDH_BUFFER_INVALID");
                return Err(PerformanceUnavailableReason::InvalidSample);
            };
            if item_bytes > storage_bytes {
                report("performance.gpu_sample", "PDH_BUFFER_INVALID");
                return Err(PerformanceUnavailableReason::InvalidSample);
            }

            // PDH wrote item_count leading structures into the aligned storage.
            // SAFETY: storage is initialized by PDH and item_bytes was checked against its size.
            let items = unsafe {
                slice::from_raw_parts(
                    storage.as_ptr().cast::<PDH_FMT_COUNTERVALUE_ITEM_W>(),
                    item_count as usize,
                )
            };
            let mut samples = Vec::with_capacity(items.len());
            for item in items {
                // Retain the name of an invalid counter so app-owned unknown
                // data cannot become 0% after unrelated valid counters survive.
                let Some(instance_name) = (unsafe {
                    wide_string(item.szName, storage.as_ptr().cast::<u8>(), storage_bytes)
                }) else {
                    continue;
                };
                let utilization = if item.FmtValue.CStatus == PDH_CSTATUS_VALID_DATA
                    || item.FmtValue.CStatus == PDH_CSTATUS_NEW_DATA
                {
                    // SAFETY: PDH_FMT_DOUBLE selects the doubleValue union member;
                    // its data is read only after checking the per-counter status.
                    Some(unsafe { item.FmtValue.Anonymous.doubleValue })
                } else {
                    None
                };
                samples.push(FormattedSample {
                    instance_name,
                    utilization,
                    unavailable_reason: utilization
                        .is_none()
                        .then(|| pdh_unavailable_reason(item.FmtValue.CStatus)),
                });
            }
            return Ok(samples);
        }

        report(
            "performance.gpu_sample_size",
            "PDH_SAMPLE_RESIZE_RETRIES_EXHAUSTED",
        );
        Err(PerformanceUnavailableReason::CounterReadFailed)
    }

    #[cfg(test)]
    mod formatted_samples_tests {
        use super::super::aggregate_gpu_engine_usage;
        use super::*;
        use windows_sys::Win32::System::Performance::PDH_CSTATUS_INVALID_DATA;

        fn requested_bytes(name: &[u16]) -> u32 {
            (mem::size_of::<PDH_FMT_COUNTERVALUE_ITEM_W>() + name.len() * mem::size_of::<u16>())
                as u32
        }

        unsafe fn write_sample(
            buffer: *mut PDH_FMT_COUNTERVALUE_ITEM_W,
            name: &[u16],
            status: u32,
        ) {
            // SAFETY: callers provide writable aligned storage sized for one item and name.
            let item = unsafe { &mut *buffer };
            let name_pointer = unsafe {
                buffer
                    .cast::<u8>()
                    .add(mem::size_of::<PDH_FMT_COUNTERVALUE_ITEM_W>())
                    .cast::<u16>()
            };
            item.szName = name_pointer;
            item.FmtValue.CStatus = status;
            item.FmtValue.Anonymous.doubleValue = 37.5;
            // SAFETY: the same writable allocation has room for the name including its terminator.
            unsafe { ptr::copy_nonoverlapping(name.as_ptr(), name_pointer, name.len()) };
        }

        #[test]
        fn valid_samples_are_reported_silently() {
            for status in [PDH_CSTATUS_VALID_DATA, PDH_CSTATUS_NEW_DATA] {
                let name: Vec<u16> = "pid_123_luid_gpu0".encode_utf16().chain([0]).collect();
                let required = requested_bytes(&name);
                let mut reports = Vec::new();
                let mut calls = 0;
                let samples = formatted_samples_with(
                    |buffer_size, item_count, buffer| {
                        calls += 1;
                        if buffer.is_null() {
                            *buffer_size = required;
                            *item_count = 1;
                            PDH_MORE_DATA
                        } else {
                            *item_count = 1;
                            // SAFETY: the helper allocated the requested bytes for this item/name.
                            unsafe { write_sample(buffer, &name, status) };
                            0
                        }
                    },
                    |operation, code| reports.push((operation.to_owned(), code.to_owned())),
                )
                .unwrap();

                assert_eq!(calls, 2);
                assert_eq!(samples.len(), 1);
                assert_eq!(samples[0].instance_name, "pid_123_luid_gpu0");
                assert_eq!(samples[0].utilization, Some(37.5));
                assert!(reports.is_empty());
            }
        }

        #[test]
        fn no_instances_and_invalid_item_status_are_silent() {
            let mut reports = Vec::new();
            let no_instances = formatted_samples_with(
                |_buffer_size, item_count, buffer| {
                    assert!(buffer.is_null());
                    *item_count = 0;
                    0
                },
                |operation, code| reports.push((operation.to_owned(), code.to_owned())),
            )
            .unwrap();
            assert!(no_instances.is_empty());

            let name: Vec<u16> = "pid_987_luid_gpu1".encode_utf16().chain([0]).collect();
            let required = requested_bytes(&name);
            let invalid = formatted_samples_with(
                |buffer_size, item_count, buffer| {
                    if buffer.is_null() {
                        *buffer_size = required;
                        *item_count = 1;
                        PDH_MORE_DATA
                    } else {
                        *item_count = 1;
                        // SAFETY: the helper allocated the requested bytes for this item/name.
                        unsafe { write_sample(buffer, &name, PDH_CSTATUS_INVALID_DATA) };
                        0
                    }
                },
                |operation, code| reports.push((operation.to_owned(), code.to_owned())),
            )
            .unwrap();

            assert_eq!(invalid.len(), 1);
            assert_eq!(invalid[0].instance_name, "pid_987_luid_gpu1");
            assert_eq!(invalid[0].utilization, None);
            assert_eq!(
                invalid[0].unavailable_reason,
                Some(PerformanceUnavailableReason::InvalidSample)
            );
            let samples = invalid
                .iter()
                .map(|sample| (sample.instance_name.as_str(), sample.utilization))
                .chain([("pid_99_luid_gpu1", Some(20.0))]);
            assert_eq!(
                aggregate_gpu_engine_usage(samples, &HashSet::from([987])),
                None
            );
            assert!(reports.is_empty());
        }

        #[test]
        fn pdh_errors_do_not_infer_permission_failures_from_absent_data() {
            assert_eq!(
                pdh_unavailable_reason(PDH_ACCESS_DENIED),
                PerformanceUnavailableReason::AccessDenied
            );
            assert_eq!(
                pdh_unavailable_reason(windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED),
                PerformanceUnavailableReason::AccessDenied
            );
            for status in [
                PDH_CSTATUS_NO_OBJECT,
                PDH_CSTATUS_NO_COUNTER,
                PDH_CSTATUS_NO_INSTANCE,
                PDH_NO_DATA,
            ] {
                assert_eq!(
                    pdh_unavailable_reason(status),
                    PerformanceUnavailableReason::CounterUnavailable
                );
            }
            assert_eq!(
                pdh_unavailable_reason(PDH_CSTATUS_INVALID_DATA),
                PerformanceUnavailableReason::InvalidSample
            );
            assert_eq!(
                pdh_unavailable_reason(windows_sys::Win32::System::Performance::PDH_INVALID_HANDLE),
                PerformanceUnavailableReason::CounterReadFailed
            );
        }

        #[test]
        fn invalid_app_item_retains_its_specific_pdh_reason() {
            let name: Vec<u16> = "pid_987_luid_gpu1".encode_utf16().chain([0]).collect();
            let required = requested_bytes(&name);
            for (status, reason) in [
                (
                    PDH_ACCESS_DENIED,
                    PerformanceUnavailableReason::AccessDenied,
                ),
                (
                    PDH_CSTATUS_NO_INSTANCE,
                    PerformanceUnavailableReason::CounterUnavailable,
                ),
                (
                    PDH_CSTATUS_INVALID_DATA,
                    PerformanceUnavailableReason::InvalidSample,
                ),
            ] {
                let values = formatted_samples_with(
                    |buffer_size, item_count, buffer| {
                        *item_count = 1;
                        if buffer.is_null() {
                            *buffer_size = required;
                            PDH_MORE_DATA
                        } else {
                            // SAFETY: the helper allocated the requested bytes for this item/name.
                            unsafe { write_sample(buffer, &name, status) };
                            0
                        }
                    },
                    |_, _| panic!("Per-item statuses are not query failures"),
                )
                .unwrap();
                let item = &values[0];
                assert_eq!(item.unavailable_reason, Some(reason));
                assert_eq!(
                    aggregate_gpu_engine_usage_with_reason(
                        [
                            (
                                item.instance_name.as_str(),
                                item.utilization.ok_or(item.unavailable_reason.unwrap())
                            ),
                            ("pid_99_luid_gpu1", Ok(20.0))
                        ],
                        &HashSet::from([987]),
                    ),
                    Err(reason)
                );
            }
        }

        #[test]
        fn pdh_more_data_recovery_is_silent() {
            let name: Vec<u16> = "pid_234_luid_gpu2".encode_utf16().chain([0]).collect();
            let required = requested_bytes(&name);
            let mut reports = Vec::new();
            let mut calls = 0;
            let samples = formatted_samples_with(
                |buffer_size, item_count, buffer| {
                    calls += 1;
                    if buffer.is_null() {
                        *buffer_size = required;
                        *item_count = 1;
                        PDH_MORE_DATA
                    } else if calls == 2 {
                        PDH_MORE_DATA
                    } else {
                        *item_count = 1;
                        // SAFETY: the helper allocated the requested bytes for this item/name.
                        unsafe { write_sample(buffer, &name, PDH_CSTATUS_VALID_DATA) };
                        0
                    }
                },
                |operation, code| reports.push((operation.to_owned(), code.to_owned())),
            )
            .unwrap();

            assert_eq!(calls, 4);
            assert_eq!(samples.len(), 1);
            assert!(reports.is_empty());
        }

        #[test]
        fn invalid_buffer_bounds_warn_once_with_fixed_codes() {
            for required in [0, (MAX_COUNTER_BUFFER_BYTES + 1) as u32] {
                let mut reports = Vec::new();
                let mut calls = 0;
                let result = formatted_samples_with(
                    |buffer_size, _item_count, buffer| {
                        calls += 1;
                        assert!(buffer.is_null());
                        *buffer_size = required;
                        PDH_MORE_DATA
                    },
                    |operation, code| reports.push((operation.to_owned(), code.to_owned())),
                );

                assert!(result.is_err());
                assert_eq!(calls, 1);
                assert_eq!(
                    reports,
                    [(
                        "performance.gpu_sample_size".to_owned(),
                        "PDH_BUFFER_INVALID".to_owned()
                    )],
                );
            }

            let required = mem::size_of::<PDH_FMT_COUNTERVALUE_ITEM_W>() as u32;
            let mut reports = Vec::new();
            let result = formatted_samples_with(
                |buffer_size, item_count, buffer| {
                    if buffer.is_null() {
                        *buffer_size = required;
                        *item_count = 1;
                        PDH_MORE_DATA
                    } else {
                        *item_count = 2;
                        0
                    }
                },
                |operation, code| reports.push((operation.to_owned(), code.to_owned())),
            );

            assert!(result.is_err());
            assert_eq!(
                reports,
                [(
                    "performance.gpu_sample".to_owned(),
                    "PDH_BUFFER_INVALID".to_owned()
                )],
            );
        }

        #[test]
        fn exhausted_resize_retries_warn_once_with_fixed_code() {
            let name: Vec<u16> = "pid_456_luid_gpu3".encode_utf16().chain([0]).collect();
            let required = requested_bytes(&name);
            let mut reports = Vec::new();
            let mut calls = 0;
            let result = formatted_samples_with(
                |buffer_size, item_count, buffer| {
                    calls += 1;
                    if buffer.is_null() {
                        *buffer_size = required;
                        *item_count = 1;
                        PDH_MORE_DATA
                    } else {
                        PDH_MORE_DATA
                    }
                },
                |operation, code| reports.push((operation.to_owned(), code.to_owned())),
            );

            assert!(result.is_err());
            assert_eq!(calls, 6);
            assert_eq!(
                reports,
                [(
                    "performance.gpu_sample_size".to_owned(),
                    "PDH_SAMPLE_RESIZE_RETRIES_EXHAUSTED".to_owned(),
                )],
            );
        }
    }

    impl Drop for PdhGpuQuery {
        fn drop(&mut self) {
            // SAFETY: this wrapper owns the query; closing it also closes its counters.
            unsafe { PdhCloseQuery(self.query as *mut c_void) };
        }
    }

    struct FormattedSample {
        instance_name: String,
        utilization: Option<f64>,
        unavailable_reason: Option<PerformanceUnavailableReason>,
    }

    unsafe fn wide_string(
        value: *const u16,
        buffer_start: *const u8,
        buffer_bytes: usize,
    ) -> Option<String> {
        if value.is_null() {
            return None;
        }

        let start = buffer_start as usize;
        let end = start.checked_add(buffer_bytes)?;
        let value_address = value as usize;
        if value_address < start
            || value_address >= end
            || !value_address.is_multiple_of(mem::align_of::<u16>())
        {
            return None;
        }

        let available_units = (end - value_address) / mem::size_of::<u16>();
        let maximum_units = available_units.min(MAX_INSTANCE_NAME_UNITS);
        let mut length = 0;
        while length < maximum_units {
            // SAFETY: the pointer was validated against the result buffer above.
            if unsafe { *value.add(length) } == 0 {
                // SAFETY: the preceding units were checked within the PDH-owned buffer.
                return Some(String::from_utf16_lossy(unsafe {
                    slice::from_raw_parts(value, length)
                }));
            }
            length += 1;
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_real_gpu_engine_instance_shape() {
        let instance = "pid_1234_luid_0x00000000_0x000120A6_phys_0_eng_1_engtype_3D";

        assert_eq!(
            parse_gpu_engine_instance(instance),
            Some((1234, "0x00000000_0x000120A6_phys_0_eng_1_engtype_3D")),
        );
    }

    #[test]
    fn rejects_malformed_gpu_engine_instances() {
        assert_eq!(parse_gpu_engine_instance("pid_nope_luid_1"), None);
        assert_eq!(parse_gpu_engine_instance("pid_1234_engtype_3D"), None);
        assert_eq!(parse_gpu_engine_instance("pid_1234_luid_"), None);
    }

    #[test]
    fn sums_processes_per_engine_then_selects_the_busiest_engine() {
        let process_ids = HashSet::from([10, 20]);
        let samples = [
            ("pid_10_luid_gpu0_phys_0_eng_0_engtype_3D", Some(35.0)),
            ("pid_20_luid_gpu0_phys_0_eng_0_engtype_3D", Some(45.0)),
            ("pid_10_luid_gpu0_phys_0_eng_1_engtype_Copy", Some(65.0)),
            ("pid_99_luid_gpu0_phys_0_eng_0_engtype_3D", Some(20.0)),
        ];

        assert_eq!(
            aggregate_gpu_engine_usage(samples, &process_ids),
            Some(80.0),
        );
    }

    #[test]
    fn caps_an_engine_at_one_hundred_percent() {
        let process_ids = HashSet::from([10, 20]);
        let samples = [
            ("pid_10_luid_gpu0_phys_0_eng_0_engtype_3D", Some(80.0)),
            ("pid_20_luid_gpu0_phys_0_eng_0_engtype_3D", Some(75.0)),
        ];

        assert_eq!(
            aggregate_gpu_engine_usage(samples, &process_ids),
            Some(100.0),
        );
    }

    #[test]
    fn returns_zero_when_valid_gpu_data_has_no_target_process() {
        let samples = [("pid_99_luid_gpu0_phys_0_eng_0_engtype_3D", Some(20.0))];

        assert_eq!(
            aggregate_gpu_engine_usage(samples, &HashSet::from([10])),
            Some(0.0),
        );
    }

    #[test]
    fn invalid_app_counters_are_unavailable_even_with_valid_other_processes() {
        let process_ids = HashSet::from([10]);
        for invalid in [None, Some(f64::NAN), Some(f64::INFINITY), Some(-1.0)] {
            let samples = [
                ("pid_10_luid_gpu0_phys_0_eng_0_engtype_3D", invalid),
                ("pid_99_luid_gpu0_phys_0_eng_0_engtype_3D", Some(20.0)),
            ];
            assert_eq!(aggregate_gpu_engine_usage(samples, &process_ids), None);
        }

        let samples = [
            ("pid_10_luid_gpu0_phys_0_eng_0_engtype_3D", Some(12.0)),
            ("pid_10_luid_gpu0_phys_0_eng_1_engtype_Copy", None),
        ];
        assert_eq!(aggregate_gpu_engine_usage(samples, &process_ids), None);
    }

    #[test]
    fn unrelated_invalid_counters_do_not_invalidate_real_app_usage_or_zero() {
        let process_ids = HashSet::from([10]);
        for utilization in [0.0, 12.5] {
            for invalid in [None, Some(f64::NAN), Some(-1.0)] {
                let samples = [
                    (
                        "pid_10_luid_gpu0_phys_0_eng_0_engtype_3D",
                        Some(utilization),
                    ),
                    ("pid_99_luid_gpu0_phys_0_eng_0_engtype_3D", invalid),
                ];
                assert_eq!(
                    aggregate_gpu_engine_usage(samples, &process_ids),
                    Some(utilization as f32),
                );
            }
        }
    }

    #[test]
    fn returns_unavailable_when_no_recognized_valid_data_exists() {
        let process_ids = HashSet::from([10]);
        let samples = [
            ("unrecognized", Some(10.0)),
            ("pid_10_luid_gpu0_phys_0_eng_0_engtype_3D", Some(f64::NAN)),
        ];

        assert_eq!(aggregate_gpu_engine_usage(samples, &process_ids), None);
    }

    #[test]
    fn missing_dataset_and_invalid_owned_values_have_distinct_reasons() {
        let owned = HashSet::from([10]);
        assert_eq!(
            aggregate_gpu_engine_usage_with_reason([], &owned),
            Err(PerformanceUnavailableReason::CounterUnavailable)
        );
        assert_eq!(
            aggregate_gpu_engine_usage_with_reason(
                [
                    ("pid_10_luid_gpu1", Ok(f64::NAN)),
                    ("pid_99_luid_gpu1", Ok(20.0)),
                ],
                &owned
            ),
            Err(PerformanceUnavailableReason::InvalidSample)
        );
        assert_eq!(
            aggregate_gpu_engine_usage_with_reason(
                [
                    ("pid_10_luid_gpu1", Ok(0.0)),
                    (
                        "pid_99_luid_gpu1",
                        Err(PerformanceUnavailableReason::AccessDenied)
                    ),
                ],
                &owned
            ),
            Ok(0.0)
        );
    }

    #[test]
    fn existing_retry_cooldown_retains_the_observed_failure_without_more_queries() {
        let mut monitor = GpuMonitor::new();
        let failed_at = Instant::now();
        monitor.mark_failed(failed_at, PerformanceUnavailableReason::AccessDenied);
        assert_eq!(monitor.retry_at, Some(failed_at + GPU_RETRY_DELAY));
        assert!(!monitor.ensure_query(failed_at));
        assert!(monitor.query.is_none());
        let sample = monitor.sample(&HashSet::from([10]));
        assert_eq!(sample.value, None);
        assert_eq!(
            sample.unavailable_reason,
            Some(PerformanceUnavailableReason::AccessDenied)
        );
        assert_eq!(monitor.retry_at, Some(failed_at + GPU_RETRY_DELAY));
    }
}
