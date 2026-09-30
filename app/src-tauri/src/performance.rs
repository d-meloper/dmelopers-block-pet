use std::{
    collections::{HashMap, HashSet},
    hash::Hash,
    sync::Mutex,
    time::Instant,
};

use serde::Serialize;
use sysinfo::{
    CpuRefreshKind, MINIMUM_CPU_UPDATE_INTERVAL, Pid, ProcessRefreshKind, ProcessesToUpdate, System,
};
use tauri::State;

mod gpu;
mod process;

use gpu::GpuMonitor;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceSample {
    pub cpu_percent: Option<f32>,
    pub ram_bytes: Option<u64>,
    pub gpu_percent: Option<f32>,
    pub available: bool,
}

impl PerformanceSample {
    fn unavailable() -> Self {
        Self {
            cpu_percent: None,
            ram_bytes: None,
            gpu_percent: None,
            available: false,
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
}

struct PerformanceMonitor {
    system: System,
    root_pid: Option<Pid>,
    logical_cpu_count: usize,
    last_refresh: Option<Instant>,
    gpu_monitor: GpuMonitor,
}

impl PerformanceMonitor {
    fn new() -> Self {
        let mut system = System::new();
        system.refresh_cpu_list(CpuRefreshKind::nothing());

        Self {
            logical_cpu_count: system.cpus().len().max(1),
            system,
            root_pid: sysinfo::get_current_pid().ok(),
            last_refresh: None,
            gpu_monitor: GpuMonitor::new(),
        }
    }

    fn prime(&mut self) {
        if sysinfo::IS_SUPPORTED_SYSTEM {
            self.last_refresh = self.refresh_processes().map(|_| Instant::now());
        }
        self.gpu_monitor.prime();
    }

    fn refresh_processes(&mut self) -> Option<HashSet<Pid>> {
        // Discover only process relationships before collecting any detailed
        // counters. Other applications' CPU/RAM and process parameters are not
        // needed to report this application's process tree.
        let root = self.root_pid.or_else(|| {
            crate::diagnostics::warn("performance.processes", "ROOT_PID_UNAVAILABLE");
            None
        })?;
        let processes = process::snapshot()
            .map_err(|error| {
                crate::diagnostics::warn(
                    "performance.process_snapshot",
                    &format!(
                        "IO_{:?}_OS_{}",
                        error.kind(),
                        error.raw_os_error().unwrap_or(0)
                    ),
                );
            })
            .ok()?;
        let selected = select_monitor_processes_with_diagnostic(
            root,
            processes.into_iter().map(|entry| {
                (
                    Pid::from_u32(entry.pid),
                    Some(Pid::from_u32(entry.parent_pid)),
                )
            }),
            |code| crate::diagnostics::warn("performance.processes", code),
        )?;
        self.refresh_selected_processes(&selected);
        Some(selected)
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
            self.system.refresh_cpu_list(CpuRefreshKind::nothing());
            self.logical_cpu_count = self.system.cpus().len().max(1);
            // The replacement System has no CPU delta baseline. Let sample's
            // existing unavailable path wait for a complete new interval.
            self.last_refresh = None;
        }
        let mut selected_ids: Vec<_> = selected.iter().copied().collect();
        selected_ids.sort_unstable_by_key(|pid| pid.as_u32());
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&selected_ids),
            true,
            ProcessRefreshKind::nothing()
                .with_cpu()
                .with_memory()
                .without_tasks(),
        );
    }

    fn sample(&mut self) -> PerformanceSample {
        if !sysinfo::IS_SUPPORTED_SYSTEM {
            return PerformanceSample::unavailable();
        }

        if let Some(last_refresh) = self.last_refresh
            && last_refresh.elapsed() < MINIMUM_CPU_UPDATE_INTERVAL
        {
            return PerformanceSample::unavailable();
        }

        let Some(selected) = self.refresh_processes() else {
            self.last_refresh = None;
            return PerformanceSample::unavailable();
        };

        let had_previous_refresh = self.last_refresh.replace(Instant::now()).is_some();
        let Some(root_pid) = self.root_pid else {
            return PerformanceSample::unavailable();
        };

        let Some(snapshot) =
            aggregate_process_tree(&self.system, root_pid, &selected, self.logical_cpu_count)
        else {
            crate::diagnostics::warn("performance.aggregate", "ROOT_PROCESS_UNAVAILABLE");
            return PerformanceSample::unavailable();
        };

        let gpu_percent = self.gpu_monitor.sample(&snapshot.process_ids);

        if !had_previous_refresh {
            return PerformanceSample::unavailable();
        }

        PerformanceSample {
            cpu_percent: Some(snapshot.metrics.cpu_percent),
            ram_bytes: Some(snapshot.metrics.memory_bytes),
            gpu_percent,
            available: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct AggregateMetrics {
    cpu_percent: f32,
    memory_bytes: u64,
}

#[derive(Debug, Clone, PartialEq)]
struct ProcessTreeSnapshot {
    metrics: AggregateMetrics,
    process_ids: HashSet<u32>,
}

fn aggregate_process_tree(
    system: &System,
    root_pid: Pid,
    selected: &HashSet<Pid>,
    logical_cpu_count: usize,
) -> Option<ProcessTreeSnapshot> {
    if !selected.contains(&root_pid) || !system.processes().contains_key(&root_pid) {
        return None;
    }

    let mut total_cpu = 0.0_f32;
    let mut total_memory = 0_u64;

    let mut process_ids = HashSet::with_capacity(selected.len());
    for pid in selected {
        if let Some(process) = system.process(*pid) {
            process_ids.insert(pid.as_u32());
            total_cpu += process.cpu_usage();
            total_memory = total_memory.saturating_add(process.memory());
        }
    }

    Some(ProcessTreeSnapshot {
        metrics: AggregateMetrics {
            cpu_percent: normalize_cpu_percent(total_cpu, logical_cpu_count),
            memory_bytes: total_memory,
        },
        process_ids,
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

#[tauri::command]
pub fn sample_app_performance(state: State<'_, PerformanceMonitorState>) -> PerformanceSample {
    let Ok(mut monitor) = state.monitor.lock() else {
        crate::diagnostics::error("performance.sample", "MONITOR_LOCK_UNAVAILABLE");
        return PerformanceSample::unavailable();
    };

    monitor.sample()
}

#[tauri::command]
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
        assert!(aggregate_process_tree(&system, root, &HashSet::new(), 1).is_none());
        let snapshot = aggregate_process_tree(&system, root, &HashSet::from([root]), 1).unwrap();
        assert_eq!(snapshot.process_ids, HashSet::from([root.as_u32()]));
    }

    #[test]
    fn releases_cached_processes_that_leave_the_selected_tree() {
        let root = sysinfo::get_current_pid().unwrap();
        let selected = HashSet::from([root]);
        let mut monitor = PerformanceMonitor::new();
        monitor.refresh_selected_processes(&selected);
        assert!(monitor.system.process(root).is_some());
        monitor.last_refresh = Some(Instant::now());

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
        assert!(!monitor.system.cpus().is_empty());
        assert_eq!(monitor.logical_cpu_count, monitor.system.cpus().len());

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

    #[test]
    fn normalizes_cpu_to_the_total_system_scale() {
        assert_eq!(normalize_cpu_percent(400.0, 8), 50.0);
        assert_eq!(normalize_cpu_percent(1_000.0, 8), 100.0);
        assert_eq!(normalize_cpu_percent(-5.0, 8), 0.0);
        assert_eq!(normalize_cpu_percent(f32::NAN, 8), 0.0);
    }

    #[test]
    fn unavailable_sample_matches_the_frontend_contract() {
        let value = serde_json::to_value(PerformanceSample::unavailable()).unwrap();

        assert!(value["cpuPercent"].is_null());
        assert!(value["ramBytes"].is_null());
        assert!(value["gpuPercent"].is_null());
        assert_eq!(value["available"], false);
    }

    #[test]
    fn ready_sample_matches_the_frontend_contract() {
        let sample = PerformanceSample {
            cpu_percent: Some(12.5),
            ram_bytes: Some(1_024),
            gpu_percent: Some(34.5),
            available: true,
        };
        let value = serde_json::to_value(sample).unwrap();

        assert_eq!(value.as_object().unwrap().len(), 4);
        assert_eq!(value["cpuPercent"], 12.5);
        assert_eq!(value["ramBytes"], 1_024);
        assert_eq!(value["gpuPercent"], 34.5);
        assert_eq!(value["available"], true);
    }
}
