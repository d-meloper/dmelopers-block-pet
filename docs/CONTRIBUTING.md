# Contributing

Public repository content is a generated distribution projection rather than a
development backup or source remote. Issues and proposed changes are reviewed as
inputs, then reproduced in the private source of truth and exported again.

Current implementation and validation target Windows 11 24H2 or newer, x64. Proposals for another
operating system need an explicit support decision and testing on that system.

Before contributing:

- search existing issues;
- describe one focused problem or change;
- do not include private assets, credentials, personal paths, generated build
  output, or third-party material without redistribution evidence;
- state the license and provenance of every new binary or media asset.

Acceptance of a proposal does not authorize a release. Public source changes,
binary candidates, and release publication each have separate validation and
approval gates.

## Build and test

On a supported Windows x64 machine, install Node.js, pnpm, Rust MSVC, Visual Studio C++ Build Tools and Windows SDK, and WebView2. Run from `app/`:

```powershell
pnpm install --frozen-lockfile
pnpm build
cargo check --locked --manifest-path src-tauri/Cargo.toml
rustup target add i686-pc-windows-msvc
$env:CARGO_TARGET_DIR = Join-Path $PWD 'target-package'
$env:RUSTFLAGS = '-C target-feature=+crt-static -C link-arg=/Brepro'
cargo build --locked --release --target x86_64-pc-windows-msvc -p block-pet-update-core --bin block-pet-update-worker
pnpm exec tauri build --target x86_64-pc-windows-msvc --no-bundle -- --locked
python tools/build_installer_utils.py --target-dir "$env:CARGO_TARGET_DIR/installer-utils" --output-dir "$env:CARGO_TARGET_DIR/x86_64-pc-windows-msvc/release"
python tools/prepare_installer_toolchain.py --evidence-dir "$env:CARGO_TARGET_DIR/installer-tool-evidence" --target-dir "$env:CARGO_TARGET_DIR"
$bundleConfig = "$env:CARGO_TARGET_DIR/installer-tool-evidence/bundle-config.json"
@{bundle=@{useLocalToolsDir=$true}} | ConvertTo-Json | Set-Content -LiteralPath $bundleConfig -Encoding utf8
pnpm exec tauri bundle --target x86_64-pc-windows-msvc --bundles nsis --config "$bundleConfig"
```

Use a fresh `target-package` directory and a Visual Studio developer shell for packaging.
The worker is built first so the app can bind its exact hash and size. The tool
preparer verifies the pinned official NSIS 3.12 archive and retains its inputs;
the separate three-command plugin preserves its upstream licenses. A local
build is not an approved distribution candidate.

Maintainer-authored issue and pull request descriptions contain the complete English text followed by the complete Korean text. Keep copyright, license and source notices with contributions.
