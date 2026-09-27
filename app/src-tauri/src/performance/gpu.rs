use std::{collections::HashSet, time::Instant};

const GPU_RETRY_DELAY: std::time::Duration = std::time::Duration::from_secs(30);

pub(super) struct GpuMonitor {
    query: Option<windows::PdhGpuQuery>,
    retry_at: Option<Instant>,
}

impl GpuMonitor {
    pub(super) fn new() -> Self {
        Self {
            query: None,
            retry_at: None,
        }
    }

    pub(super) fn prime(&mut self) {
        let now = Instant::now();
        if !self.ensure_query(now) {
            return;
        }

        if self
            .query
            .as_mut()
            .is_some_and(|query| query.prime().is_err())
        {
            self.mark_failed(now);
        }
    }

    pub(super) fn sample(&mut self, process_ids: &HashSet<u32>) -> Option<f32> {
        let now = Instant::now();
        if !self.ensure_query(now) {
            return None;
        }

        match self
            .query
            .as_mut()
            .expect("GPU query must exist after ensure_query")
            .sample(process_ids)
        {
            Ok(value) => value,
            Err(()) => {
                self.mark_failed(now);
                None
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
                true
            }
            Err(()) => {
                self.retry_at = Some(now + GPU_RETRY_DELAY);
                false
            }
        }
    }

    fn mark_failed(&mut self, now: Instant) {
        self.query = None;
        self.retry_at = Some(now + GPU_RETRY_DELAY);
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

fn aggregate_gpu_engine_usage<'a>(
    samples: impl IntoIterator<Item = (&'a str, f64)>,
    process_ids: &HashSet<u32>,
) -> Option<f32> {
    let mut recognized_sample = false;
    let mut engine_totals = std::collections::HashMap::<&str, f64>::new();

    for (instance_name, utilization) in samples {
        let Some((pid, engine_key)) = parse_gpu_engine_instance(instance_name) else {
            continue;
        };
        if !utilization.is_finite() || utilization < 0.0 {
            continue;
        }

        recognized_sample = true;
        if process_ids.contains(&pid) {
            *engine_totals.entry(engine_key).or_default() += utilization;
        }
    }

    if !recognized_sample {
        return None;
    }

    Some(
        engine_totals
            .into_values()
            .map(|value| value.clamp(0.0, 100.0))
            .fold(0.0_f64, f64::max) as f32,
    )
}

mod windows {
    use std::{collections::HashSet, ffi::c_void, mem, ptr, slice};

    use windows_sys::{
        Win32::System::Performance::{
            PDH_CSTATUS_NEW_DATA, PDH_CSTATUS_VALID_DATA, PDH_FMT_COUNTERVALUE_ITEM_W,
            PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY, PDH_MORE_DATA, PdhAddEnglishCounterW,
            PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW, PdhOpenQueryW,
        },
        w,
    };

    use super::aggregate_gpu_engine_usage;

    const MAX_COUNTER_BUFFER_BYTES: usize = 16 * 1024 * 1024;
    const MAX_INSTANCE_NAME_UNITS: usize = 4096;

    pub(super) struct PdhGpuQuery {
        query: usize,
        counter: usize,
        primed: bool,
    }

    impl PdhGpuQuery {
        pub(super) fn open() -> Result<Self, ()> {
            let mut query: PDH_HQUERY = ptr::null_mut();
            // SAFETY: PDH initializes the out handle and receives a null data-source pointer.
            let status = unsafe { PdhOpenQueryW(ptr::null(), 0, &mut query) };
            if status != 0 {
                crate::diagnostics::warn("performance.gpu_open", &format!("PDH_0x{status:08X}"));
                return Err(());
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
                return Err(());
            }

            Ok(Self {
                query: query as usize,
                counter: counter as usize,
                primed: false,
            })
        }

        pub(super) fn prime(&mut self) -> Result<(), ()> {
            self.collect()?;
            self.primed = true;
            Ok(())
        }

        pub(super) fn sample(&mut self, process_ids: &HashSet<u32>) -> Result<Option<f32>, ()> {
            self.collect()?;
            if !self.primed {
                self.primed = true;
                return Ok(None);
            }

            let samples = self.formatted_samples()?;
            Ok(aggregate_gpu_engine_usage(
                samples
                    .iter()
                    .map(|sample| (sample.instance_name.as_str(), sample.utilization)),
                process_ids,
            ))
        }

        fn collect(&self) -> Result<(), ()> {
            // SAFETY: the query handle remains valid for the lifetime of this wrapper.
            match unsafe { PdhCollectQueryData(self.query as PDH_HQUERY) } {
                0 => Ok(()),
                status => {
                    crate::diagnostics::warn("performance.gpu_collect", &format!("PDH_0x{status:08X}"));
                    Err(())
                },
            }
        }

        fn formatted_samples(&self) -> Result<Vec<FormattedSample>, ()> {
            for _ in 0..3 {
                let mut buffer_size = 0_u32;
                let mut item_count = 0_u32;
                // SAFETY: a null buffer with a zero size asks PDH for the required byte count.
                let first_status = unsafe {
                    PdhGetFormattedCounterArrayW(
                        self.counter as PDH_HCOUNTER,
                        PDH_FMT_DOUBLE,
                        &mut buffer_size,
                        &mut item_count,
                        ptr::null_mut(),
                    )
                };
                if first_status == 0 && item_count == 0 {
                    return Ok(Vec::new());
                }
                if first_status != PDH_MORE_DATA {
                    crate::diagnostics::warn("performance.gpu_sample_size", &format!("PDH_0x{first_status:08X}"));
                    return Err(());
                }

                let required_bytes = buffer_size as usize;
                if required_bytes == 0 || required_bytes > MAX_COUNTER_BUFFER_BYTES {
                    return Err(());
                }
                let word_count = required_bytes.div_ceil(mem::size_of::<usize>());
                let mut storage = vec![0_usize; word_count];

                // SAFETY: storage is pointer-aligned and has at least buffer_size writable bytes.
                let second_status = unsafe {
                    PdhGetFormattedCounterArrayW(
                        self.counter as PDH_HCOUNTER,
                        PDH_FMT_DOUBLE,
                        &mut buffer_size,
                        &mut item_count,
                        storage.as_mut_ptr().cast::<PDH_FMT_COUNTERVALUE_ITEM_W>(),
                    )
                };
                if second_status == PDH_MORE_DATA {
                    continue;
                }
                if second_status != 0 {
                    crate::diagnostics::warn("performance.gpu_sample", &format!("PDH_0x{second_status:08X}"));
                    return Err(());
                }

                let storage_bytes = storage
                    .len()
                    .checked_mul(mem::size_of::<usize>())
                    .ok_or(())?;
                let item_bytes = (item_count as usize)
                    .checked_mul(mem::size_of::<PDH_FMT_COUNTERVALUE_ITEM_W>())
                    .ok_or(())?;
                if item_bytes > storage_bytes {
                    return Err(());
                }

                // SAFETY: PDH wrote item_count leading structures into the aligned storage.
                let items = unsafe {
                    slice::from_raw_parts(
                        storage.as_ptr().cast::<PDH_FMT_COUNTERVALUE_ITEM_W>(),
                        item_count as usize,
                    )
                };
                let mut samples = Vec::with_capacity(items.len());
                for item in items {
                    if item.FmtValue.CStatus != PDH_CSTATUS_VALID_DATA
                        && item.FmtValue.CStatus != PDH_CSTATUS_NEW_DATA
                    {
                        continue;
                    }
                    // SAFETY: PDH returns a null-terminated instance name inside storage.
                    let Some(instance_name) = (unsafe {
                        wide_string(item.szName, storage.as_ptr().cast::<u8>(), storage_bytes)
                    }) else {
                        continue;
                    };
                    // SAFETY: PDH_FMT_DOUBLE selects the doubleValue union member.
                    let utilization = unsafe { item.FmtValue.Anonymous.doubleValue };
                    samples.push(FormattedSample {
                        instance_name,
                        utilization,
                    });
                }
                return Ok(samples);
            }

            Err(())
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
        utilization: f64,
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
            ("pid_10_luid_gpu0_phys_0_eng_0_engtype_3D", 35.0),
            ("pid_20_luid_gpu0_phys_0_eng_0_engtype_3D", 45.0),
            ("pid_10_luid_gpu0_phys_0_eng_1_engtype_Copy", 65.0),
            ("pid_99_luid_gpu0_phys_0_eng_0_engtype_3D", 20.0),
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
            ("pid_10_luid_gpu0_phys_0_eng_0_engtype_3D", 80.0),
            ("pid_20_luid_gpu0_phys_0_eng_0_engtype_3D", 75.0),
        ];

        assert_eq!(
            aggregate_gpu_engine_usage(samples, &process_ids),
            Some(100.0),
        );
    }

    #[test]
    fn returns_zero_when_valid_gpu_data_has_no_target_process() {
        let samples = [("pid_99_luid_gpu0_phys_0_eng_0_engtype_3D", 20.0)];

        assert_eq!(
            aggregate_gpu_engine_usage(samples, &HashSet::from([10])),
            Some(0.0),
        );
    }

    #[test]
    fn returns_unavailable_when_no_recognized_valid_data_exists() {
        let process_ids = HashSet::from([10]);
        let samples = [
            ("unrecognized", 10.0),
            ("pid_10_luid_gpu0_phys_0_eng_0_engtype_3D", f64::NAN),
        ];

        assert_eq!(aggregate_gpu_engine_usage(samples, &process_ids), None);
    }
}
