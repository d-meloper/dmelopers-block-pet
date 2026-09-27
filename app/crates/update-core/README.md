# Shared update protocol and dedicated worker

The application retains its WebViews, input, broadcast, network download and
user-data coordinator. This crate owns the authenticated feed, bounded process
identity queries, program journal, rollback and shared filesystem receipts. It
has no Tauri, WebView, input, broadcast, HTTP client or sysinfo runtime dependency.
Native failure notices are callbacks implemented by the application adapter and
the worker entry point.

Build `block-pet-update-worker` before the application, with the same target,
profile and repository feature. The app build binds the sibling worker's SHA256
and size in its compiled identity. The worker's PE product/file version comes
from this crate's independent package version. An app-only version change does
not change that resource. Private QA still checks the app manifest against its
0.9.x fixture version. A missing debug packaging identity prevents an update;
release builds require the prebuilt worker. The private QA feature embeds only
its frozen compile-time trust, remains visibly marked and has no runtime override.

The app copies the verified installed `block-pet-update-worker.exe` to the
operation's `update-helper.exe` and executes that copy. It never copies the main
application as a new helper. The installed worker can therefore be replaced by
NSIS while the staged worker owns the transaction. The original worker is also
part of the exact rollback snapshot.

The new application's entry point retains the minimal legacy install guard but
rejects the three worker-only command modes. It does not invoke the worker
transaction dispatcher. Normal app boot and update-health arguments retain their
existing route; old staged version 1 executables remain their own recovery owner.

New operations always use program record/journal version 2, even when their
target feed is version 1. The record binds the source worker's identity to the
original program inventory and staged bytes. `parentStarted` retains the legacy
Unix-second unit; version 2 also requires `parentCreated100ns` and compares the
exact FILETIME ticks, including on worker reentry. Only version 1 uses seconds
for identity comparison. Missing processes and failed process queries are
different results; failed queries cannot authorize replacement.

Existing version 1 operation records and journals are read without rewriting
them. Their retained helper remains bound to the original main-executable hash.
Boot recovery continues to launch that retained original executable, while
terminal cleanup verifies the corresponding legacy binding.

Feed version 1 keeps its exact four-file contract and omits `installer`. Old
clients cannot read version 2 metadata. An upgrade from an old client therefore
requires a reviewed, signed version 1 bridge feed pointing to the complete new
signed installer before version 2 metadata is offered. The whole-installer
signature also covers its additional worker bytes; the bridge does not change
the old client's installed-file schema. Publishing or replacing a feed is a
separate operation, never an automatic runtime fallback.

Feed version 2 requires exactly five installed-file hashes and `minUpdaterSchema`
2. Its additional `installer` object binds format, installation protocol version,
worker protocol/path/hash/size and optional internal MSI identity. NSIS requires
`msi: null`. WiX Burn requires the strict MSI identity but is currently metadata
only: the application and worker reject it before preparing a transaction until
its installation, registration and rollback adapter is implemented. No feed can
supply command-line arguments.

The signed protocol fixtures use a disposable test key whose private key was
discarded. Their opaque installer bytes test signature coverage, v1/v2 parsing
and malformed metadata rejection. They are not executable installers or evidence
of installed Windows runtime verification.
