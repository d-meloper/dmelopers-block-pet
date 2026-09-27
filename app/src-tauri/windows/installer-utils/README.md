# Historical installer utility plugin

This source is retained for provenance and earlier installer implementations.
The current GitHub and Store packaging does not build or include this DLL.
The instructions below describe the historical helper workflow, not a prerequisite
for the standalone current-channel build.

`block_pet_installer_utils.dll` contains only the three NSIS commands used by
the historical Block Pet installer: `SemverCompare`, `FindProcess`, and `RunAsUser`. It is an installer
plugin, not an installed application file. It must be built before bundling and
placed beside `dmelopers-3d-block-pet.exe`; the custom NSIS template loads it from that build
input directory. The resulting installer extracts the DLL to `$PLUGINSDIR`.

The implementation derives from the official
[Tauri nsis-tauri-utils 0.5.3 source](https://github.com/tauri-apps/nsis-tauri-utils/tree/nsis_tauri_utils-v0.5.3).
`upstream-provenance.json` pins the archive and original source hashes. The
vendored `nsis-plugin-api` and `nsis-fn` files are unchanged. Both upstream license
texts are retained. Include the Tauri copyright and full MIT terms in the
distribution's third-party notices, and include this independent Cargo.lock in
the dependency inventory. Do not describe this locally derived DLL as an
official or Authenticode-signed Tauri release.

Changes from upstream:

- Use a local runtime subset with the Windows `BOOL` return type for `DllMain`.
  The retained upstream macro returns Rust `bool`, which has a different ABI
  width. Allocation and panic behavior remain the same; original vendor files
  and their recorded hashes remain unchanged.
- Retain semantic-version comparison, including the original invalid-version
  ordering and prerelease behavior.
- Remove string utilities, process termination, and current-user-only process
  commands. Link through `exports.def` to expose exactly three commands, without
  changing the linked PE bytes afterward.
- `FindProcess` checks the first snapshot entry and all subsequent entries,
  skips its NSIS host PID, and matches names case-insensitively across sessions.
  It returns `0` for a match, `1` only after a complete no-match scan, and `2` for
  an inspection failure. The uninstaller proceeds only for exactly `1`.
- Preserve the 0.5.3 `CreateProcessWithTokenW` launch path and temporary privilege
  restoration. Token-query failure no longer means unelevated. An elevated
  installer must obtain a non-elevated shell token; failure does not fall back
  to launching the app with its installer token. Direct non-elevated launch
  continues to use `ShellExecuteW`. `RunAsUser` returns `0` on launch success and
  `1` on failure; it does not claim application health or wait for app exit.

The output is an x86 Unicode NSIS plugin even though the app is x64. Build with
`python tools/build_installer_utils.py --target-dir <isolated-build-dir>
--output-dir <app-release-dir>`. If the i686 Rust standard library is prepared
outside rustup, add `--sysroot <verified-sysroot>`. The script never installs
tools. It uses available MSVC x86/x64 tools and Windows SDK libraries, a locked
Cargo dependency graph, static CRT configuration, an explicit three-command DEF, and
the MSVC `/Brepro` option for deterministic linking.
The current no-std plugin uses the Win32 heap and has no linked CRT objects,
TLS initialization or GS cookie; its small entry point does not skip required
CRT initialization. Reassess that fact if its dependencies or imports change.
It rejects unexpected exports, architecture, process-termination imports, and
non-reviewed imported DLLs. Build/link logs and the exact source/tool/output
inventory are written to the output directory; only the DLL is a bundle input.

Run the Rust unit tests for the independent crate and
the maintainer's `test_installer_packaging.py` harness with
`BLOCK_PET_NSIS_COMPILER`, `BLOCK_PET_INSTALLER_UTILS_DLL`,
`BLOCK_PET_TAURI_NSIS_INCLUDE_DIR`, and `BLOCK_PET_7ZIP_PATH` set to reviewed
external tools/inputs. Python fixtures run a benign GUI child and temporary
shortcuts only. They verify real NSIS ABI calls, Unicode/space arguments,
non-elevated launch, process matching, shortcut migration and preservation,
and whether a configured StartMenu page actually embeds StartMenu.dll.
These tests do not establish elevated cross-account launch or a packaged
product installation; those remain separate integration checks.

For Tauri CLI 2.11.4, `bundle.useLocalToolsDir=true` selects
`<Cargo metadata.target_directory>/.tauri/NSIS`. A prepared official NSIS 3.12
tree can be used there without changing the user's global Tauri cache. Keep
the original official 0.5.3 plugin under `Plugins/x86-unicode/additional`, since
Tauri still validates that file against its fixed hash even when the custom
template does not call it. Never substitute this derived DLL at that path.
Record the compiler/stub/plugin hashes and version before and after bundling;
Tauri can recreate an incomplete local tool tree with its default version.

Removing unused commands and updating the official NSIS toolchain reduces
unneeded capabilities and includes upstream fixes. Neither change proves an
antivirus cause or guarantees a clean verdict. Security reports must refer to
the exact final installer and extracted component bytes.
