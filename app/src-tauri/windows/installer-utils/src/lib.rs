//! Three NSIS entrypoints used by the Block Pet installer.
//! Derived from Tauri's MIT/Apache-2.0 nsis-tauri-utils 0.5.3.
#![no_std]

#[cfg(not(test))]
mod runtime;

mod process;
mod semver;
