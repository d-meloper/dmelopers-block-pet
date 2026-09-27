# Contributing

This is the standalone public source projection for DMeloper's Block Pet, an independent personal project. Proposed changes are reviewed and reproduced in the source of truth before a new projection is prepared. Preserve licenses and asset provenance; do not include credentials, personal paths, user data, or build outputs.

## Build and check

Use Windows 11 24H2 or newer x64, Node.js 24, pnpm 11.15.1, Rust MSVC, Visual Studio C++ Build Tools and Windows SDK 10.0.26100.0 or newer. Run from `app/` in a normal PowerShell session. The build wrapper activates the x64 tools while preserving Unicode profile paths:

```powershell
pnpm install --frozen-lockfile
python -m unittest discover -s scripts/packaging -p test_*.py
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/packaging/build.ps1 --validation --reviewed-public-commit (git rev-parse HEAD) --output C:/BlockPetBuild/validation-001
```

Use a clean committed checkout and a fresh output directory outside it. This builds the GitHub NSIS installer and Store MSIX, validates the MSIX manifest, and writes a receipt with source, tool, input and output identities. The Store validation identity is explicitly synthetic and cannot be submitted as a release. `scripts/packaging/store-identity.example.json` lists the required registered Partner Center fields; empty values fail closed.

Public CI checks both packages without uploading binaries, build artifacts, or binary-bearing public caches. A CI result does not prove byte identity with a local release. A real release build requires the reviewed public commit, retained projection manifest, registered Store identity and a reviewed exact tool lock; it is produced locally and is still subject to signing, security, installation and joint publication checks. No private harness is needed to build the public application.

Microsoft Store packages use packagedClassicApp, mediumIL, runFullTrust, StartupTask and update-while-in-use deferral. The manifest requires Windows build 26100. Store identity and installed payload after Microsoft signing are verified separately from the submitted package SHA-256. See Microsoft's [package manifest guidance](https://learn.microsoft.com/windows/msix/desktop/desktop-to-uwp-manual-conversion) and [update deferral reference](https://learn.microsoft.com/uwp/schemas/appxpackage/uapmanifestschema/element-uap17-updatewhileinuse).

Acceptance of a source change does not authorize publication. Maintainer issue and PR descriptions place full English text before full Korean text.
