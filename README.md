# DMeloper's Block Pet

[![Release](https://raw.githubusercontent.com/d-meloper/dmelopers-block-pet/badges/release.svg)](https://github.com/d-meloper/dmelopers-block-pet/releases/latest) [![Downloads](https://raw.githubusercontent.com/d-meloper/dmelopers-block-pet/badges/downloads.svg)](https://github.com/d-meloper/dmelopers-block-pet/releases) [![Stars](https://raw.githubusercontent.com/d-meloper/dmelopers-block-pet/badges/stars.svg)](https://github.com/d-meloper/dmelopers-block-pet/stargazers) [![License](https://raw.githubusercontent.com/d-meloper/dmelopers-block-pet/badges/license.svg)](LICENSE)

A Minecraft-style desktop pet with keyboard and mouse reactions, PNG skins, presets and optional OBS browser output.

Supports Windows 11 24H2 or newer, x64.

Download the setup EXE and its `.sig` file from the [official Releases page](https://github.com/d-meloper/dmelopers-block-pet/releases).

Edge's **“isn't commonly downloaded”** message is a download-reputation warning, not by itself a malware finding. It also does not establish that a file is safe. The first release has no Authenticode signature, so Windows may show an unknown-publisher warning. The detached Tauri `.sig` signature is separate from Authenticode and does not establish Windows publisher reputation. See Microsoft's [SmartScreen explanation](https://feedback.smartscreen.microsoft.com/smartscreenfaq.aspx) and [code-signing guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options).

Before running the installer, compare the SHA-256 of both downloaded files with **Checksums** in that version's release notes. In PowerShell, use `Get-FileHash -Algorithm SHA256 -LiteralPath 'C:\path\downloaded-file.exe'`, replacing the example path, then repeat for the `.sig` file. A match confirms the published bytes; it does not certify safety or independently identify the publisher. If a checksum differs or your security software reports malware, stop and [report the exact warning](docs/SUPPORT.md).

Install [Microsoft WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) first if it is missing. Installation is for the current Windows user.

1. In settings, choose **Quit App** before running the installer. If a file cannot be written because the app is still running, quit the app normally and choose **Retry** in the same installer. If it still fails, check the displayed error before retrying; a write failure can have another cause.
2. Complete installation, then choose **Close**. If no shortcut with the same name exists, a **Yes / No** prompt offers to create a desktop shortcut. Existing shortcuts are preserved. The app is not launched automatically.

Settings > About > **Program version management** checks the latest version at app start and when you open About. Choose **Open latest version link** to visit Releases, then verify the repository and version before downloading. Close the app and reinstall into the recorded folder to update. Settings, presets and skins are preserved, including on uninstall. If you cancel or interrupt installation, close the app and run the same installer again to repair its files. Installer download and installation are manual; automatic recovery and automatic WebView2 installation are not provided.

[Download](https://github.com/d-meloper/dmelopers-block-pet/releases/latest) · [한국어](README.ko-KR.md) · [Support](docs/SUPPORT.md) · [Privacy](docs/PRIVACY.md) · [Security](docs/SECURITY.md) · [Contributing](docs/CONTRIBUTING.md) · [Third-party notices](docs/THIRD_PARTY_NOTICES.md)

Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.
