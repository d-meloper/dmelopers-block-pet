# Block Pet's pinned updater

Upstream: `tauri-plugin-updater` 2.11.0, crates.io archive SHA-256
`b28d8cabdeb0564f03ae261963de4bc3d98321cd3d213e76a81b7d344e5df606`.
Original source commit is retained in `.cargo_vcs_info.json`; original manifest
is retained in `Cargo.toml.orig`. The upstream MIT and Apache-2.0 licenses apply.

Only two runtime changes in `src/updater.rs`:

1. Bound each metadata response to 64 KiB before JSON parsing, including chunked
   bodies without Content-Length. The application also verifies signed identity.
2. On Windows, invoke the existing before-exit cleanup callback only after
   ShellExecuteW reports successful installer handoff. Failure leaves the app
   usable; successful handoff is not evidence of successful installation.

No worker/guard, rollback, download provider or signing algorithm is added.
Application startup integration tests exercise the raw metadata bound over HTTP.
Operation and frontend tests cover cancellation and restoration after a failed
handoff. Actual Windows installer handoff and installed behavior still require
the owner's manual verification.
