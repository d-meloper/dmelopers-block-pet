use std::{
    collections::{HashMap, HashSet},
    hash::Hash,
    sync::Mutex,
    time::Instant,
};

use serde::Serialize;
use sysinfo::{MINIMUM_CPU_UPDATE_INTERVAL, Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::State;

mod gpu;
mod memory;
mod process;

use gpu::GpuMonitor;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PerformanceUnavailableReason {
    Unsupported,
    AccessDenied,
    ProcessUnavailable,
    ProcessSnapshotFailed,
    CounterUnavailable,
    CounterReadFailed,
    Initializing,
    IntervalTooShort,
    InvalidSample,
    SamplingFailed,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct PerformanceUnavailableReasons {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu: Option<PerformanceUnavailableReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu: Option<PerformanceUnavailableReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ram: Option<PerformanceUnavailableReason>,
}

impl PerformanceUnavailableReasons {
    fn is_empty(&self) -> bool {
        self.cpu.is_none() && self.gpu.is_none() && self.ram.is_none()
    }
}

#[derive(Debug, Clone, PartialEq)]
struct MetricReading<T> {
    value: Option<T>,
    unavailable_reason: Option<PerformanceUnavailableReason>,
}

impl<T> MetricReading<T> {
    fn unavailable(reason: PerformanceUnavailableReason) -> Self {
        Self::from_result(Err(reason))
    }

    fn from_result(result: Result<T, PerformanceUnavailableReason>) -> Self {
        match result {
            Ok(value) => Self {
                value: Some(value),
                unavailable_reason: None,
            },
            Err(reason) => Self {
                value: None,
                unavailable_reason: Some(reason),
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceSample {
    pub cpu_percent: Option<f32>,
    pub ram_bytes: Option<u64>,
    pub gpu_percent: Option<f32>,
    pub available: bool,
    #[serde(skip_serializing_if = "PerformanceUnavailableReasons::is_empty")]
    pub unavailable_reasons: PerformanceUnavailableReasons,
}

impl PerformanceSample {
    fn unavailable(reason: PerformanceUnavailableReason) -> Self {
        Self {
            cpu_percent: None,
            ram_bytes: None,
            gpu_percent: None,
            available: false,
            unavailable_reasons: PerformanceUnavailableReasons {
                cpu: Some(reason),
                gpu: Some(reason),
                ram: Some(reason),
            },
        }
    }

    fn from_readings(
        cpu: MetricReading<f32>,
        gpu: MetricReading<f32>,
        ram: MetricReading<u64>,
    ) -> Self {
        Self {
            cpu_percent: cpu.value,
            ram_bytes: ram.value,
            gpu_percent: gpu.value,
            available: true,
            unavailable_reasons: PerformanceUnavailableReasons {
                cpu: cpu.unavailable_reason,
                gpu: gpu.unavailable_reason,
                ram: ram.unavailable_reason,
            },
        }
    }
}

pub struct PerformanceMonitorState {
    monitor: Mutex<PerformanceMonitor>,
}

impl PerformanceMonitorState {
    pub fn new() -> Self {
        Self {
            monitor: Mutex::new(PerformanceMonitor::new()),
        }
    }

    #[cfg(test)]
    pub(super) fn while_monitor_locked<T>(&self, check: impl FnOnce() -> T) -> T {
        let _monitor = self.monitor.lock().expect("test monitor lock");
        check()
    }
}

struct PerformanceMonitor {
    system: System,
    root_pid: Option<Pid>,
    logical_cpu_count: usize,
    last_refresh: Option<Instant>,
    gpu_monitor: GpuMonitor,
    cpu_sampler: CpuUsageSampler,
}

impl PerformanceMonitor {
    fn new() -> Self {
        let system = System::new();

        Self {
            logical_cpu_count: system_logical_cpu_count(),
            system,
            root_pid: sysinfo::get_current_pid().ok(),
            last_refresh: None,
            gpu_monitor: GpuMonitor::new(),
            cpu_sampler: CpuUsageSampler::default(),
        }
    }

    fn prime(&mut self) {
        self.cpu_sampler.reset();
        if sysinfo::IS_SUPPORTED_SYSTEM {
            if let Ok(selected) = self.refresh_processes() {
                let sampled_at = Instant::now();
                self.last_refresh = Some(sampled_at);
                let processes = self.root_pid.and_then(|root| {
                    aggregate_process_tree(&self.system, root, &selected)
                        .filter(|snapshot| snapshot.cpu_times.len() == selected.len())
                        .map(|snapshot| snapshot.cpu_times)
                });
                let _ = self
                    .cpu_sampler
                    .sample(processes, sampled_at, self.logical_cpu_count);
            } else {
                self.last_refresh = None;
            }
        }
        self.gpu_monitor.prime();
    }

    fn refresh_processes(&mut self) -> Result<HashSet<Pid>, PerformanceUnavailableReason> {
        // Discover only process relationships before collecting any detailed
        // counters. Other applications' CPU/RAM and process parameters are not
        // needed to report this application's process tree.
        let root = self.root_pid.ok_or_else(|| {
            crate::diagnostics::warn("performance.processes", "ROOT_PID_UNAVAILABLE");
            PerformanceUnavailableReason::ProcessUnavailable
        })?;
        let processes = process::snapshot().map_err(|error| {
            crate::diagnostics::warn(
                "performance.process_snapshot",
                &format!(
                    "IO_{:?}_OS_{}",
                    error.kind(),
                    error.raw_os_error().unwrap_or(0)
                ),
            );
            if error.kind() == std::io::ErrorKind::PermissionDenied {
                PerformanceUnavailableReason::AccessDenied
            } else {
                PerformanceUnavailableReason::ProcessSnapshotFailed
            }
        })?;
        let selected = select_monitor_processes_with_diagnostic(
            root,
            processes.into_iter().map(|entry| {
                (
                    Pid::from_u32(entry.pid),
                    Some(Pid::from_u32(entry.parent_pid)),
                )
            }),
            |code| crate::diagnostics::warn("performance.processes", code),
        )
        .ok_or(PerformanceUnavailableReason::ProcessUnavailable)?;
        self.refresh_selected_processes(&selected);
        Ok(selected)
    }

    fn refresh_selected_processes(&mut self, selected: &HashSet<Pid>) {
        // sysinfo only evicts dead PIDs included in ProcessesToUpdate::Some.
        // A child that left the selected tree would otherwise keep its cached
        // Process (and Windows process handle) for the rest of this session.
        // Its public API cannot remove one cached entry, so rebuild only when
        // needed, without collecting details about no-longer-selected PIDs.
        if self
            .system
            .processes()
            .keys()
            .any(|pid| !selected.contains(pid))
        {
            self.system = System::new();
            // The replacement System needs a new cumulative CPU-time baseline.
            self.cpu_sampler.reset();
            self.last_refresh = None;
        }
        self.logical_cpu_count = system_logical_cpu_count();
        let mut selected_ids: Vec<_> = selected.iter().copied().collect();
        selected_ids.sort_unstable_by_key(|pid| pid.as_u32());
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&selected_ids),
            true,
            ProcessRefreshKind::nothing().with_cpu().without_tasks(),
        );
    }

    fn sample(&mut self) -> PerformanceSample {
        if !sysinfo::IS_SUPPORTED_SYSTEM {
            return PerformanceSample::unavailable(PerformanceUnavailableReason::Unsupported);
        }

        if let Some(last_refresh) = self.last_refresh
            && last_refresh.elapsed() < MINIMUM_CPU_UPDATE_INTERVAL
        {
            return PerformanceSample::unavailable(PerformanceUnavailableReason::IntervalTooShort);
        }

        let selected = match self.refresh_processes() {
            Ok(selected) => selected,
            Err(reason) => {
                self.last_refresh = None;
                self.cpu_sampler.reset();
                return PerformanceSample::unavailable(reason);
            }
        };

        // Match cumulative CPU-time deltas to successive collection completion
        // times. A delayed request measures its actual interval, not one second.
        let sampled_at = Instant::now();
        self.last_refresh = Some(sampled_at);
        let Some(root_pid) = self.root_pid else {
            self.cpu_sampler.reset();
            return PerformanceSample::unavailable(
                PerformanceUnavailableReason::ProcessUnavailable,
            );
        };

        let Some(snapshot) = aggregate_process_tree(&self.system, root_pid, &selected) else {
            crate::diagnostics::warn("performance.aggregate", "ROOT_PROCESS_UNAVAILABLE");
            self.cpu_sampler.reset();
            return PerformanceSample::unavailable(
                PerformanceUnavailableReason::ProcessUnavailable,
            );
        };

        // A child can exit between relationship discovery and counter refresh.
        // Keep current RAM/GPU readings, but never publish a partial CPU sum.
        let complete_cpu_times =
            (snapshot.cpu_times.len() == selected.len()).then_some(snapshot.cpu_times);
        let cpu_percent =
            self.cpu_sampler
                .sample(complete_cpu_times, sampled_at, self.logical_cpu_count);
        let gpu = self.gpu_monitor.sample(&snapshot.process_ids);
        let ram = MetricReading::from_result(
            // Task Manager's app Memory column is private resident memory, not
            // the sum of shared-inclusive working sets or committed bytes.
            memory::sample(selected.iter().map(|pid| pid.as_u32())).map_err(|error| {
                crate::diagnostics::warn(
                    "performance.private_working_set",
                    &format!(
                        "IO_{:?}_OS_{}",
                        error.kind(),
                        error.raw_os_error().unwrap_or(0)
                    ),
                );
                memory::unavailable_reason(&error)
            }),
        );

        PerformanceSample::from_readings(
            MetricReading {
                value: cpu_percent,
                unavailable_reason: self.cpu_sampler.unavailable_reason,
            },
            gpu,
            ram,
        )
    }
}

fn system_logical_cpu_count() -> usize {
    use windows_sys::Win32::System::Threading::{ALL_PROCESSOR_GROUPS, GetActiveProcessorCount};

    // GetSystemInfo (used by sysinfo's CPU list) covers only one processor group.
    // Our wall-time denominator must include every active logical CPU instead.
    // SAFETY: this read-only system query takes a documented constant and no pointers.
    let count = unsafe { GetActiveProcessorCount(ALL_PROCESSOR_GROUPS) } as usize;
    if count == 0 {
        crate::diagnostics::warn(
            "performance.cpu_count",
            "ACTIVE_PROCESSOR_COUNT_UNAVAILABLE",
        );
    }
    count
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ProcessCpuTime {
    start_time: u64,
    accumulated_ms: u64,
}

struct CpuBaseline {
    sampled_at: Instant,
    logical_cpu_count: usize,
    processes: HashMap<u32, ProcessCpuTime>,
}

#[derive(Default)]
struct CpuUsageSampler {
    previous: Option<CpuBaseline>,
    unavailable_reason: Option<PerformanceUnavailableReason>,
}

impl CpuUsageSampler {
    fn reset(&mut self) {
        self.previous = None;
        self.unavailable_reason = None;
    }

    fn sample(
        &mut self,
        processes: Option<HashMap<u32, ProcessCpuTime>>,
        sampled_at: Instant,
        logical_cpu_count: usize,
    ) -> Option<f32> {
        let processes = processes
            .ok_or(PerformanceUnavailableReason::ProcessUnavailable)
            .and_then(|processes| {
                if logical_cpu_count == 0 {
                    Err(PerformanceUnavailableReason::CounterUnavailable)
                } else if processes.is_empty() {
                    Err(PerformanceUnavailableReason::ProcessUnavailable)
                } else if processes.values().any(|process| process.start_time == 0) {
                    // sysinfo does not expose the underlying Win32 error. An
                    // invalid identity is observable; its hardware/permission
                    // cause is not, so do not infer access denied from zero.
                    Err(PerformanceUnavailableReason::InvalidSample)
                } else {
                    Ok(processes)
                }
            });
        let processes = match processes {
            Ok(processes) => processes,
            Err(reason) => {
                self.reset();
                self.unavailable_reason = Some(reason);
                return None;
            }
        };
        let current = CpuBaseline {
            sampled_at,
            logical_cpu_count,
            processes,
        };
        let result = self
            .previous
            .as_ref()
            .ok_or(PerformanceUnavailableReason::Initializing)
            .and_then(|previous| cpu_percent_between(previous, &current));
        // Even a changed tree or a reset counter is a fresh baseline. Returning
        // None for that interval prevents boot/lifetime or partial-tree usage.
        self.previous = Some(current);
        self.unavailable_reason = result.as_ref().err().copied();
        result.ok()
    }
}

fn cpu_percent_between(
    previous: &CpuBaseline,
    current: &CpuBaseline,
) -> Result<f32, PerformanceUnavailableReason> {
    let elapsed = current
        .sampled_at
        .checked_duration_since(previous.sampled_at)
        .ok_or(PerformanceUnavailableReason::InvalidSample)?;
    if elapsed < MINIMUM_CPU_UPDATE_INTERVAL {
        return Err(PerformanceUnavailableReason::IntervalTooShort);
    }
    if previous.logical_cpu_count != current.logical_cpu_count
        || previous.processes.len() != current.processes.len()
    {
        return Err(PerformanceUnavailableReason::Initializing);
    }

    let mut total_cpu_ms = 0.0_f64;
    for (pid, process) in &current.processes {
        let previous_process = previous
            .processes
            .get(pid)
            .ok_or(PerformanceUnavailableReason::Initializing)?;
        if process.start_time != previous_process.start_time {
            return Err(PerformanceUnavailableReason::Initializing);
        }
        total_cpu_ms += process
            .accumulated_ms
            .checked_sub(previous_process.accumulated_ms)
            .ok_or(PerformanceUnavailableReason::InvalidSample)? as f64;
    }

    Ok(normalize_cpu_percent(
        (100.0 * total_cpu_ms / (elapsed.as_secs_f64() * 1_000.0)) as f32,
        current.logical_cpu_count,
    ))
}

#[derive(Debug, Clone, PartialEq)]
struct ProcessTreeSnapshot {
    process_ids: HashSet<u32>,
    cpu_times: HashMap<u32, ProcessCpuTime>,
}

fn aggregate_process_tree(
    system: &System,
    root_pid: Pid,
    selected: &HashSet<Pid>,
) -> Option<ProcessTreeSnapshot> {
    if !selected.contains(&root_pid) || !system.processes().contains_key(&root_pid) {
        return None;
    }

    // GPU counters must use the same observed tree as RAM, including children
    // whose sysinfo CPU counters disappeared or could not be refreshed. Using
    // only sysinfo-present IDs can misclassify a valid app GPU engine as an
    // unrelated process and silently turn its usage into an idle zero.
    let process_ids = selected.iter().map(|pid| pid.as_u32()).collect();
    let mut cpu_times = HashMap::with_capacity(selected.len());
    for pid in selected {
        if let Some(process) = system.process(*pid) {
            // sysinfo 0.39.6 refreshes accumulated CPU milliseconds before its
            // first-sample/short-interval cpu_usage early return on Windows.
            cpu_times.insert(
                pid.as_u32(),
                ProcessCpuTime {
                    start_time: process.start_time(),
                    accumulated_ms: process.accumulated_cpu_time(),
                },
            );
        }
    }

    Some(ProcessTreeSnapshot {
        process_ids,
        cpu_times,
    })
}

fn select_monitor_processes(
    root: Pid,
    process_parents: impl IntoIterator<Item = (Pid, Option<Pid>)>,
) -> Option<HashSet<Pid>> {
    let process_parents: Vec<_> = process_parents.into_iter().collect();
    if !process_parents.iter().any(|(pid, _)| *pid == root) {
        return None;
    }
    Some(collect_descendants(root, process_parents))
}

fn select_monitor_processes_with_diagnostic(
    root: Pid,
    process_parents: impl IntoIterator<Item = (Pid, Option<Pid>)>,
    mut report: impl FnMut(&'static str),
) -> Option<HashSet<Pid>> {
    let selected = select_monitor_processes(root, process_parents);
    if selected.is_none() {
        report("ROOT_PROCESS_NOT_ENUMERATED");
    }
    selected
}

fn collect_descendants<T>(
    root: T,
    process_parents: impl IntoIterator<Item = (T, Option<T>)>,
) -> HashSet<T>
where
    T: Copy + Eq + Hash,
{
    let mut children_by_parent: HashMap<T, Vec<T>> = HashMap::new();
    for (pid, parent) in process_parents {
        if let Some(parent) = parent {
            children_by_parent.entry(parent).or_default().push(pid);
        }
    }

    let mut descendants = HashSet::from([root]);
    let mut pending = vec![root];

    while let Some(parent) = pending.pop() {
        let Some(children) = children_by_parent.get(&parent) else {
            continue;
        };

        for child in children {
            if descendants.insert(*child) {
                pending.push(*child);
            }
        }
    }

    descendants
}

fn normalize_cpu_percent(total_cpu_percent: f32, logical_cpu_count: usize) -> f32 {
    if !total_cpu_percent.is_finite() {
        return 0.0;
    }

    (total_cpu_percent / logical_cpu_count.max(1) as f32).clamp(0.0, 100.0)
}

// Native process/PDH collection and mutex waits must not run in the IPC callback.
#[tauri::command(async)]
pub fn sample_app_performance(state: State<'_, PerformanceMonitorState>) -> PerformanceSample {
    let Ok(mut monitor) = state.monitor.lock() else {
        crate::diagnostics::error("performance.sample", "MONITOR_LOCK_UNAVAILABLE");
        return PerformanceSample::unavailable(PerformanceUnavailableReason::SamplingFailed);
    };

    monitor.sample()
}

#[tauri::command(async)]
pub fn prime_app_performance_sampler(state: State<'_, PerformanceMonitorState>) {
    if let Ok(mut monitor) = state.monitor.lock() {
        monitor.prime();
    } else {
        crate::diagnostics::error("performance.prime", "MONITOR_LOCK_UNAVAILABLE");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collects_the_root_and_all_recursive_children_only() {
        let processes = [
            (1_u32, None),
            (2, Some(1)),
            (3, Some(2)),
            (4, Some(1)),
            (9, None),
            (10, Some(9)),
        ];

        let descendants = collect_descendants(1, processes);

        assert_eq!(descendants, HashSet::from([1, 2, 3, 4]));
    }

    #[test]
    fn descendant_collection_is_safe_when_parent_data_contains_a_cycle() {
        let processes = [(1_u32, None), (2, Some(1)), (3, Some(2)), (2, Some(3))];

        let descendants = collect_descendants(1, processes);

        assert_eq!(descendants, HashSet::from([1, 2, 3]));
    }

    #[test]
    fn detailed_monitoring_requires_an_observed_root_and_excludes_unrelated_processes() {
        let root = Pid::from_u32(1);
        let child = Pid::from_u32(2);
        let unrelated = Pid::from_u32(9);
        let mut warnings = Vec::new();
        assert_eq!(
            select_monitor_processes_with_diagnostic(root, [(child, Some(root))], |code| {
                warnings.push(code)
            }),
            None
        );
        assert_eq!(warnings, ["ROOT_PROCESS_NOT_ENUMERATED"]);

        warnings.clear();
        assert_eq!(
            select_monitor_processes_with_diagnostic(
                root,
                [(root, None), (child, Some(root)), (unrelated, None)],
                |code| warnings.push(code),
            ),
            Some(HashSet::from([root, child]))
        );
        assert!(warnings.is_empty());
    }

    #[test]
    fn stale_cached_processes_outside_the_current_tree_are_not_aggregated() {
        let root = sysinfo::get_current_pid().unwrap();
        let mut system = System::new();
        system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[root]),
            true,
            ProcessRefreshKind::nothing().with_memory().without_tasks(),
        );
        assert!(system.process(root).is_some());
        assert!(aggregate_process_tree(&system, root, &HashSet::new()).is_none());
        let snapshot = aggregate_process_tree(&system, root, &HashSet::from([root])).unwrap();
        assert_eq!(snapshot.process_ids, HashSet::from([root.as_u32()]));
    }

    #[test]
    fn unreadable_child_cpu_counters_cannot_remove_its_valid_gpu_usage() {
        let root = sysinfo::get_current_pid().unwrap();
        let child = Pid::from_u32(u32::MAX);
        let mut system = System::new();
        system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[root]),
            true,
            ProcessRefreshKind::nothing().with_cpu().without_tasks(),
        );
        let selected = HashSet::from([root, child]);
        let snapshot = aggregate_process_tree(&system, root, &selected).unwrap();
        assert_eq!(snapshot.cpu_times.len(), 1);
        assert_eq!(
            snapshot.process_ids,
            HashSet::from([root.as_u32(), child.as_u32()])
        );

        let engine_name = format!("pid_{}_luid_gpu0_phys_0_eng_0_engtype_3D", child.as_u32());
        let counters = [(engine_name.as_str(), Some(47.5))];
        // Negative control reproduces the old sysinfo-only process scope: the
        // child's valid engine was treated as unrelated, producing idle zero.
        let cpu_only_ids = snapshot.cpu_times.keys().copied().collect();
        assert_eq!(
            gpu::aggregate_gpu_engine_usage(counters, &cpu_only_ids),
            Some(0.0)
        );
        assert_eq!(
            gpu::aggregate_gpu_engine_usage(counters, &snapshot.process_ids),
            Some(47.5)
        );
    }

    #[test]
    fn releases_cached_processes_that_leave_the_selected_tree() {
        let root = sysinfo::get_current_pid().unwrap();
        let selected = HashSet::from([root]);
        let mut monitor = PerformanceMonitor::new();
        monitor.refresh_selected_processes(&selected);
        assert!(monitor.system.process(root).is_some());
        monitor.last_refresh = Some(Instant::now());
        let _ = monitor.cpu_sampler.sample(
            cpu_times(&[(root.as_u32(), 10, 100)]),
            Instant::now(),
            monitor.logical_cpu_count,
        );
        assert!(monitor.cpu_sampler.previous.is_some());

        // Reproduce the dependency behavior that made remove_dead_processes
        // insufficient: PIDs omitted from Some are never inspected or removed.
        monitor.system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[]),
            true,
            ProcessRefreshKind::nothing().without_tasks(),
        );
        assert!(monitor.system.process(root).is_some());

        monitor.refresh_selected_processes(&HashSet::new());
        assert!(monitor.system.processes().is_empty());
        assert!(monitor.last_refresh.is_none());
        assert!(monitor.system.cpus().is_empty());
        assert!(monitor.cpu_sampler.previous.is_none());
        assert_eq!(monitor.logical_cpu_count, system_logical_cpu_count());

        // Resuming collection, including a PID seen in an earlier selection,
        // starts fresh instead of reusing the evicted process's delta state.
        monitor.refresh_selected_processes(&selected);
        assert_eq!(monitor.system.processes().len(), 1);
        assert!(monitor.system.process(root).is_some());
        assert!(monitor.last_refresh.is_none());
    }

    #[test]
    fn stable_process_selection_preserves_the_existing_cpu_baseline() {
        let root = sysinfo::get_current_pid().unwrap();
        let selected = HashSet::from([root]);
        let mut monitor = PerformanceMonitor::new();
        monitor.refresh_selected_processes(&selected);
        let baseline = Instant::now();
        monitor.last_refresh = Some(baseline);

        monitor.refresh_selected_processes(&selected);

        assert_eq!(monitor.system.processes().len(), 1);
        assert!(monitor.system.process(root).is_some());
        assert_eq!(monitor.last_refresh, Some(baseline));
    }

    fn cpu_times(rows: &[(u32, u64, u64)]) -> Option<HashMap<u32, ProcessCpuTime>> {
        Some(
            rows.iter()
                .map(|(pid, start_time, accumulated_ms)| {
                    (
                        *pid,
                        ProcessCpuTime {
                            start_time: *start_time,
                            accumulated_ms: *accumulated_ms,
                        },
                    )
                })
                .collect(),
        )
    }

    #[test]
    fn computes_first_cpu_interval_from_cumulative_milliseconds_not_boot_lifetime() {
        let at = Instant::now();
        let mut sampler = CpuUsageSampler::default();
        // Windows sysinfo updates accumulated time even before cpu_usage has
        // established a delta. Using 5,800 / system uptime would hide this load.
        assert_eq!(sampler.sample(cpu_times(&[(1, 10, 5_000)]), at, 8), None);
        assert_eq!(
            sampler.sample(
                cpu_times(&[(1, 10, 5_800)]),
                at + std::time::Duration::from_secs(1),
                8,
            ),
            Some(10.0),
        );
        assert_eq!(
            sampler.sample(
                cpu_times(&[(1, 10, 5_800)]),
                at + std::time::Duration::from_secs(2),
                8,
            ),
            Some(0.0),
        );
    }

    #[test]
    fn uses_actual_elapsed_cpu_interval_and_all_processor_groups() {
        let at = Instant::now();
        let mut sampler = CpuUsageSampler::default();
        assert_eq!(sampler.sample(cpu_times(&[(1, 10, 100)]), at, 128), None);
        assert_eq!(
            sampler.sample(
                cpu_times(&[(1, 10, 2_100)]),
                at + std::time::Duration::from_secs(2),
                128,
            ),
            // One fully busy logical CPU over two seconds on a 128-thread OS.
            Some(0.78125),
        );
        assert_eq!(
            sampler.sample(
                cpu_times(&[(1, 10, 3_100)]),
                at + std::time::Duration::from_secs(3),
                64,
            ),
            None,
        );
        assert_eq!(
            sampler.sample(
                cpu_times(&[(1, 10, 4_100)]),
                at + std::time::Duration::from_secs(4),
                64,
            ),
            Some(1.5625),
        );
    }

    #[test]
    fn rebases_cpu_when_children_enter_or_leave_without_publishing_partial_usage() {
        let at = Instant::now();
        let mut sampler = CpuUsageSampler::default();
        assert_eq!(sampler.sample(cpu_times(&[(1, 10, 100)]), at, 4), None);
        assert_eq!(
            sampler.sample(
                cpu_times(&[(1, 10, 300), (2, 20, 50)]),
                at + std::time::Duration::from_secs(1),
                4,
            ),
            None,
        );
        assert_eq!(
            sampler.sample(
                cpu_times(&[(1, 10, 500), (2, 20, 250)]),
                at + std::time::Duration::from_secs(2),
                4,
            ),
            Some(10.0),
        );
        assert_eq!(
            sampler.sample(
                cpu_times(&[(1, 10, 700)]),
                at + std::time::Duration::from_secs(3),
                4,
            ),
            None,
        );
        assert_eq!(
            sampler.sample(
                cpu_times(&[(1, 10, 900)]),
                at + std::time::Duration::from_secs(4),
                4,
            ),
            Some(5.0),
        );
    }

    #[test]
    fn rebases_cpu_on_pid_reuse_and_backward_counters() {
        let at = Instant::now();
        let mut sampler = CpuUsageSampler::default();
        assert_eq!(sampler.sample(cpu_times(&[(1, 10, 100)]), at, 2), None);
        assert_eq!(
            sampler.sample(
                cpu_times(&[(1, 20, 200)]),
                at + std::time::Duration::from_secs(1),
                2,
            ),
            None,
        );
        assert_eq!(
            sampler.sample(
                cpu_times(&[(1, 20, 300)]),
                at + std::time::Duration::from_secs(2),
                2,
            ),
            Some(5.0),
        );
        assert_eq!(
            sampler.sample(
                cpu_times(&[(1, 20, 0)]),
                at + std::time::Duration::from_secs(3),
                2,
            ),
            None,
        );
        assert_eq!(
            sampler.sample(
                cpu_times(&[(1, 20, 100)]),
                at + std::time::Duration::from_secs(4),
                2,
            ),
            Some(5.0),
        );
    }

    #[test]
    fn missing_or_unreadable_cpu_snapshots_require_a_fresh_complete_baseline() {
        let at = Instant::now();
        for invalid in [None, cpu_times(&[]), cpu_times(&[(1, 0, 100)])] {
            let mut sampler = CpuUsageSampler::default();
            assert_eq!(sampler.sample(cpu_times(&[(1, 10, 100)]), at, 4), None);
            assert_eq!(
                sampler.sample(invalid, at + std::time::Duration::from_secs(1), 4),
                None,
            );
            assert_eq!(
                sampler.sample(
                    cpu_times(&[(1, 10, 500)]),
                    at + std::time::Duration::from_secs(2),
                    4,
                ),
                None,
            );
            assert_eq!(
                sampler.sample(
                    cpu_times(&[(1, 10, 700)]),
                    at + std::time::Duration::from_secs(3),
                    4,
                ),
                Some(5.0),
            );
        }
    }

    #[test]
    fn short_cpu_intervals_and_reset_never_publish_cached_values() {
        let at = Instant::now();
        let mut sampler = CpuUsageSampler::default();
        assert_eq!(sampler.sample(cpu_times(&[(1, 10, 100)]), at, 4), None);
        let too_soon = at + MINIMUM_CPU_UPDATE_INTERVAL / 2;
        assert_eq!(
            sampler.sample(cpu_times(&[(1, 10, 120)]), too_soon, 4),
            None
        );
        let expected = normalize_cpu_percent(
            (100.0 * 20.0 / (MINIMUM_CPU_UPDATE_INTERVAL.as_secs_f64() * 1_000.0)) as f32,
            4,
        );
        assert_eq!(
            sampler.sample(
                cpu_times(&[(1, 10, 140)]),
                too_soon + MINIMUM_CPU_UPDATE_INTERVAL,
                4,
            ),
            Some(expected),
        );
        sampler.reset();
        assert_eq!(
            sampler.sample(
                cpu_times(&[(1, 10, 160)]),
                too_soon + std::time::Duration::from_secs(1),
                4,
            ),
            None,
        );
        assert_eq!(
            sampler.sample(
                cpu_times(&[(1, 10, 180)]),
                too_soon + std::time::Duration::from_secs(2),
                0,
            ),
            None,
        );
        assert!(sampler.previous.is_none());
    }

    #[test]
    fn a_missing_cpu_baseline_preserves_the_independent_ram_and_gpu_contract() {
        let value = serde_json::to_value(PerformanceSample {
            cpu_percent: None,
            ram_bytes: Some(1_024),
            gpu_percent: Some(7.5),
            available: true,
            unavailable_reasons: PerformanceUnavailableReasons::default(),
        })
        .unwrap();

        assert_eq!(value.as_object().unwrap().len(), 4);
        assert!(value["cpuPercent"].is_null());
        assert_eq!(value["ramBytes"], 1_024);
        assert_eq!(value["gpuPercent"], 7.5);
        assert_eq!(value["available"], true);
    }

    #[test]
    fn normalizes_cpu_to_the_total_system_scale() {
        assert_eq!(normalize_cpu_percent(400.0, 8), 50.0);
        assert_eq!(normalize_cpu_percent(1_000.0, 8), 100.0);
        assert_eq!(normalize_cpu_percent(-5.0, 8), 0.0);
        assert_eq!(normalize_cpu_percent(f32::NAN, 8), 0.0);
    }

    #[test]
    fn unavailable_sample_matches_the_frontend_contract() {
        let value = serde_json::to_value(PerformanceSample::unavailable(
            PerformanceUnavailableReason::SamplingFailed,
        ))
        .unwrap();

        assert!(value["cpuPercent"].is_null());
        assert!(value["ramBytes"].is_null());
        assert!(value["gpuPercent"].is_null());
        assert_eq!(value["available"], false);
        assert_eq!(
            value["unavailableReasons"],
            serde_json::json!({
                "cpu": "samplingFailed", "gpu": "samplingFailed", "ram": "samplingFailed",
            })
        );
    }

    #[test]
    fn ready_sample_matches_the_frontend_contract() {
        let sample = PerformanceSample {
            cpu_percent: Some(12.5),
            ram_bytes: Some(1_024),
            gpu_percent: Some(34.5),
            available: true,
            unavailable_reasons: PerformanceUnavailableReasons::default(),
        };
        let value = serde_json::to_value(sample).unwrap();

        assert_eq!(value.as_object().unwrap().len(), 4);
        assert_eq!(value["cpuPercent"], 12.5);
        assert_eq!(value["ramBytes"], 1_024);
        assert_eq!(value["gpuPercent"], 34.5);
        assert_eq!(value["available"], true);
    }

    #[test]
    fn resource_reasons_are_optional_partial_and_never_leak_into_recovered_samples() {
        let value = serde_json::to_value(PerformanceSample::from_readings(
            MetricReading::unavailable(PerformanceUnavailableReason::Initializing),
            MetricReading::from_result(Ok(0.0)),
            MetricReading::unavailable(PerformanceUnavailableReason::AccessDenied),
        ))
        .unwrap();
        assert!(value["cpuPercent"].is_null());
        assert_eq!(value["gpuPercent"], 0.0);
        assert!(value["ramBytes"].is_null());
        assert_eq!(value["available"], true);
        assert_eq!(
            value["unavailableReasons"],
            serde_json::json!({
                "cpu": "initializing", "ram": "accessDenied",
            })
        );

        let recovered = serde_json::to_value(PerformanceSample::from_readings(
            MetricReading::from_result(Ok(0.0)),
            MetricReading::from_result(Ok(0.0)),
            MetricReading::from_result(Ok(0)),
        ))
        .unwrap();
        assert_eq!(recovered.as_object().unwrap().len(), 4);
        assert!(recovered.get("unavailableReasons").is_none());
        assert_eq!(recovered["cpuPercent"], 0.0);
        assert_eq!(recovered["gpuPercent"], 0.0);
        assert_eq!(recovered["ramBytes"], 0);
    }

    #[test]
    fn cpu_reasons_distinguish_preparation_missing_processes_and_invalid_counters() {
        let at = Instant::now();
        let mut sampler = CpuUsageSampler::default();
        assert_eq!(sampler.sample(cpu_times(&[(1, 10, 100)]), at, 4), None);
        assert_eq!(
            sampler.unavailable_reason,
            Some(PerformanceUnavailableReason::Initializing)
        );
        assert_eq!(
            sampler.sample(
                cpu_times(&[(1, 10, 140)]),
                at + MINIMUM_CPU_UPDATE_INTERVAL / 2,
                4
            ),
            None
        );
        assert_eq!(
            sampler.unavailable_reason,
            Some(PerformanceUnavailableReason::IntervalTooShort)
        );
        assert!(
            sampler
                .sample(
                    cpu_times(&[(1, 10, 340)]),
                    at + std::time::Duration::from_secs(1),
                    4
                )
                .is_some()
        );
        assert!(sampler.unavailable_reason.is_none());

        assert_eq!(
            sampler.sample(
                cpu_times(&[(1, 10, 340), (2, 20, 100)]),
                at + std::time::Duration::from_secs(2),
                4
            ),
            None
        );
        assert_eq!(
            sampler.unavailable_reason,
            Some(PerformanceUnavailableReason::Initializing)
        );
        assert_eq!(
            sampler.sample(
                cpu_times(&[(1, 10, 0), (2, 20, 100)]),
                at + std::time::Duration::from_secs(3),
                4
            ),
            None
        );
        assert_eq!(
            sampler.unavailable_reason,
            Some(PerformanceUnavailableReason::InvalidSample)
        );
        assert_eq!(
            sampler.sample(None, at + std::time::Duration::from_secs(4), 4),
            None
        );
        assert_eq!(
            sampler.unavailable_reason,
            Some(PerformanceUnavailableReason::ProcessUnavailable)
        );
        assert_eq!(
            sampler.sample(
                cpu_times(&[(1, 0, 100)]),
                at + std::time::Duration::from_secs(5),
                4
            ),
            None
        );
        assert_eq!(
            sampler.unavailable_reason,
            Some(PerformanceUnavailableReason::InvalidSample)
        );
        assert_eq!(
            sampler.sample(
                cpu_times(&[(1, 10, 100)]),
                at + std::time::Duration::from_secs(6),
                0
            ),
            None
        );
        assert_eq!(
            sampler.unavailable_reason,
            Some(PerformanceUnavailableReason::CounterUnavailable)
        );
        sampler.reset();
        assert!(sampler.unavailable_reason.is_none());
    }
}
