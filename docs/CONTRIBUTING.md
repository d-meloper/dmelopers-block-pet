# Contributing

[한국어](CONTRIBUTING.ko-KR.md) · English

## Suggestions and Changes

Use [GitHub Issues](https://github.com/d-meloper/dmelopers-block-pet/issues) to report a problem or suggest a feature. Describe what you want to do and what gets in the way.

For a pull request, explain the problem, the change and how you checked it. Keep unrelated changes separate. Preserve licenses and asset sources, and leave out credentials, personal paths, user data and build outputs.

This public source can be built on its own. Accepted changes are incorporated into the maintained source before the next public source update.

## Build Requirements

- Windows 11 24H2 or newer, x64
- Node.js 24 and pnpm 11.15.1
- Python 3.11 or newer
- Rust MSVC, Visual Studio C++ Build Tools and Windows SDK 10.0.26100.0 or newer

## Build and Check

Run these commands from `app/` in a normal PowerShell session. The build script sets up the x64 tools and supports Unicode profile paths.

```powershell
pnpm install --frozen-lockfile
python -m unittest discover -s scripts/packaging -p test_*.py
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/packaging/build.ps1 --validation --reviewed-public-commit (git rev-parse HEAD) --output C:/BlockPetBuild/validation-001
```

Use a committed checkout with no local changes and a new output folder outside it. This builds the GitHub NSIS installer and Store MSIX, checks the MSIX manifest, and records the source, tools and output files.

The `--validation` build uses a sample Store identity and cannot be submitted to the Store. The required Partner Center registration fields are listed in `scripts/packaging/store-identity.example.json`. A release build stops if any required value is missing.

For repeated local builds, add `--cache-root C:/BlockPetBuild/compiler-cache`. Keep this absolute folder separate from source and candidate outputs. The builder locks it, separates GitHub and Store compiler outputs and tools, and copies each result into a new output folder. Cached compilation does not replace output verification.

## Release Builds

Public CI checks both packages. It does not upload binaries, build artifacts or binary caches. Passing CI does not establish that its files match a local release byte for byte.

Release builds are produced locally from the reviewed public commit, with the retained source export manifest, registered Store identity and exact tool versions. Signing, security checks, installation checks and publication checks follow separately. You do not need the maintainer's private tools to build the public app.

Store packages declare `packagedClassicApp`, `mediumIL`, `runFullTrust`, `StartupTask` and update-while-in-use deferral. They require Windows build 26100 or newer. The installed identity and files after Microsoft signing are checked separately from the submitted package hash.

See Microsoft's [package manifest guidance](https://learn.microsoft.com/windows/msix/desktop/desktop-to-uwp-manual-conversion) and [update deferral reference](https://learn.microsoft.com/uwp/schemas/appxpackage/uapmanifestschema/element-uap17-updatewhileinuse).

Accepting a source change does not publish a release. Maintainer issue and PR descriptions use English first, followed by Korean.
