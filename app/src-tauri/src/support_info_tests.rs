// Integration targets receive the Common-Controls manifest from build.rs.
// Compile the actual readers and helpers, without launching the application.
#![allow(dead_code)]
mod diagnostics;
mod windows_process;
