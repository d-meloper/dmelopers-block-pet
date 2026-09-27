# Third-Party Notices

## Upstream application code

Parts of DMeloper's Block Pet are derived from
[`ayangweb/BongoCat` v1.1.0](https://github.com/ayangweb/BongoCat/tree/v1.1.0),
licensed under the MIT License.

- Annotated tag object: `2a4e3b51706fe9e1ed5f8e39aed02336583a8823`
- Peeled source commit: `84f9f4ccfb11d8a4aefb9623934637878be0e384`
- Upstream copyright: `Copyright (c) 2025 ayangweb`

The upstream MIT copyright and permission notice are preserved in `LICENSE`.
DMeloper's Block Pet contains substantial independent changes and is not an
official BongoCat release or endorsed by the upstream project.

The upstream software license does not by itself grant rights to unrelated or
pre-existing character artwork, names, brands, user skins, 3D/Live2D models,
music, or trademarks. No Bongo Cat character model or upstream Live2D model is
part of the public source projection or installer.

## Vendored source

`../app/vendor/tauri-winres` contains a local patch of `tauri-winres` 0.3.5. It remains
under its original MIT license, preserved at `../app/vendor/tauri-winres/LICENSE`, and
retains the original Tauri Apps Contributors and Max Resch copyright notices.

The installer-only `block_pet_installer_utils.dll` is derived from
[Tauri nsis-tauri-utils 0.5.3](https://github.com/tauri-apps/nsis-tauri-utils/tree/nsis_tauri_utils-v0.5.3).
Its source is retained at `../app/src-tauri/windows/installer-utils`, including
the original MIT and Apache-2.0 texts, the original copyright
`Copyright (c) 2019 - 2022 Tauri Programme within The Commons Conservancy`, and
the pinned upstream archive/source hashes. The local derivative retains only
version comparison, process inspection and non-elevated application launch;
unused process-termination and string commands were removed. The vendored
`nsis-plugin-api` and `nsis-fn` sources are unchanged. This locally built DLL is
not an official or Authenticode-signed Tauri release.

The application's shared update core and separate update worker are maintained
under the project MIT license in `../app/crates/update-core`. Their external
dependencies are included in the offline dependency notices, with the app,
worker and installer plugin recorded as separate build consumers.

## Runtime assets

The voxel humanoid geometry and default skin were authored by DMeloper. The application icon was supplied by the maintainer and approved for use in the application; no additional authorship claim is made. The GLB intentionally contains no embedded character skin.
A separate `default.png`, authored by DMeloper, provides the default appearance.
The author has approved its inclusion in the public source and installer.
User-imported skins are excluded from the public source projection and installer.

`Minecraft`, `Steve`, `Mojang`, and `Microsoft` are names or marks of
their respective owners. This independent project is not an official Minecraft
product and is not approved by or associated with Mojang or Microsoft. A
compatibility description does not grant rights to third-party game assets or
user-provided skins.

## UI iconography

Selected [Solar Icons](https://icon-sets.iconify.design/solar/) by
[480 Design](https://www.figma.com/community/file/1166831539721848736) are used
under the [Creative Commons Attribution 4.0 International License](https://creativecommons.org/licenses/by/4.0/).
The application adapts their rendered size and color without modifying the
original icon shapes.

Selected [Lucide Icons](https://icon-sets.iconify.design/lucide/) by the Lucide
Contributors are used under the
[ISC License, with MIT notices for Feather-derived icons](https://github.com/lucide-icons/lucide/blob/main/LICENSE).
The selected arrow and square icons include Feather-derived artwork by Cole
Bemis. Preserve both applicable license texts and copyright notices in the
final offline notices; the package's ISC metadata alone is not the full notice.

Icon data is supplied by local `@iconify-json` packages and rendered as CSS by
UnoCSS. The application does not fetch these icons from a CDN at runtime.

## Offline dependency notices and source availability

Open Preferences > About > Licenses and Privacy to read this document, the
project MIT license, privacy information, and dependency notices without an
internet connection. The same text is included in `../app/src/legal/notices.txt`.
The CycloneDX inventory is `../app/src/legal/dependencies.cdx.json`.

The inventory covers locked Node production dependencies, Solar/Lucide icon
data compiled into CSS, the x64 application's and update worker's Windows Rust
normal/build dependency closure, and the x86 installer's independent utility
plugin closure. Both Cargo lockfiles are recorded and development-only
dependencies are excluded.
Build dependencies are included conservatively; listing a package does not
claim its code is linked into the installed executable.

Original LICENSE/NOTICE files are retained where supplied. For identified
packages that publish an SPDX license declaration without a standalone license
file, the notices preserve author metadata and available original source
headers and provide the corresponding standard license terms. No missing
copyright year or holder is invented.

MPL-2.0 covered dependencies remain available under MPL-2.0 at the exact
versioned source download URLs in the offline notices. These registry
dependencies are not modified by this project. Their applicable licenses and
source availability are independent of the MIT license for this application.
