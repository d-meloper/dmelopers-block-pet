# Support

[한국어](SUPPORT.ko-KR.md) · English

## Installation

Install from the [Microsoft Store](https://apps.microsoft.com/detail/9PLKW6NBMKQ7?hl=en-US), or download the `.exe` installer from [GitHub Releases](https://github.com/d-meloper/dmelopers-block-pet/releases). The accompanying `.sig` file is used for verification and is not required for normal installation. GitHub installations are for the current Windows account.

DMeloper's Block Pet requires x64 Windows 10 22H2 with the September 2023 cumulative update (build 19045.3448) or later. Windows 11 requires 22H2 with the September 2023 cumulative update (build 22621.2283) or later. Windows 11 24H2 (build 26100) or newer is recommended. The app is available in English and Korean.

The app's and WiX installer's minimum-requirements warning allows you to acknowledge it and continue, but operation below the minimum is not guaranteed. Very old Windows versions may fail to load the program before the warning appears. The Store package configuration sets its minimum installation version to `10.0.19045.3448`. On Windows 11, the app also checks the Windows 11 minimum above.

Microsoft WebView2 Runtime is required. If version 120 or newer is missing, the WiX installer runs a verified Microsoft bootstrapper to install it. This step requires an internet connection. If installation fails, use the Microsoft installation page opened by the app, install the runtime, then retry. You can also exit and return later.

## Updates and Repair

In the GitHub edition, open Settings > About to check signed update information from the official repository. Installation starts after you click the update button. You can cancel until settings saving begins. The app verifies the installer before starting installation.

If a WiX installation asks you to close the app, quit it normally. If installation is interrupted, run the same installer again to repair the program files. Windows Installer handles rollback of program-file changes; the app does not automatically restore personal data from an earlier backup.

The Microsoft Store edition is configured to use Windows-managed installation and updates. The About page opens the Store listing or its downloads and updates page. Windows 11 24H2 or newer defers Store app updates while the app is running. Earlier supported Windows versions use their default Store update behavior. Quit the app fully from the tray menu before applying an update; restarting the app alone does not guarantee that the update is applied.

See [Security](SECURITY.md) for download warnings, checksums and signatures.

## Settings and Skins

For storage locations and reset or uninstall options, see the [Data Management Guide](https://aismash.notion.site/3f32dc0bb4ae80808222e5e0cf123464). The [Privacy Policy](https://aismash.notion.site/3f32dc0bb4ae803ea9aed8d3b366c391) explains information processing and contact form data. Both guides are maintained on Notion.

## Full-screen Games

The pet may not be visible in full-screen games even with Always on Top enabled. Please set the game's display mode to windowed or borderless windowed mode.

## Questions and Bug Reports

Use [GitHub Issues](https://github.com/d-meloper/dmelopers-block-pet/issues) for questions, bugs and suggestions. Include:

- App version or source commit, and whether you use GitHub, Microsoft Store, a test edition or a source build.
- Whether this was a new installation, update or reinstall; include the previous version if applicable.
- Installer filename, if applicable, Windows version and display scaling.
- Steps to reproduce the problem, what you expected and what happened.

For direct questions, email [dmeloper@gmail.com](mailto:dmeloper@gmail.com).

You can attach the relevant part of a diagnostic log. Remove personal paths, skins, nicknames, tokens and other private information first.

Report vulnerabilities privately using the [Security policy](SECURITY.md).
