# Support

[한국어](SUPPORT.ko-KR.md) · English

## Installation

DMeloper's Block Pet supports Windows 11 24H2 (build 26100) or newer, x64, and is available in English and Korean.

Download the installer from [Releases](https://github.com/d-meloper/dmelopers-block-pet/releases). GitHub installations are for the current Windows account.

Microsoft WebView2 Runtime is required. If it is missing, the app or installer opens Microsoft's installation page. Install it, then choose Retry. You can also exit and return later. WebView2 is not downloaded or installed automatically.

## Updates and Repair

In the GitHub edition, open Settings > About to check for updates. The app checks signed update information and starts installation after you click the update button. You can cancel until settings saving begins.

If asked to close the app, quit it normally. If an installation is interrupted, run the same installer again to repair the program files. The app does not automatically return to the previous version.

Windows manages installation and updates for the Microsoft Store edition. The About page opens the Store listing.

See [Security](SECURITY.md) for download warnings, checksums and signatures.

## Settings and Skins

Official GitHub and Store installations share settings, presets and skins in `Saved Games\DMeloper's Block Pet`. A normal GitHub uninstall keeps shared and installation-specific data. Its uninstaller removes the shared data plus the GitHub edition's `%LOCALAPPDATA%` and `%APPDATA%` data when you select and confirm “Remove all personal settings and files”; this also removes the shared settings, presets and skins used by an installed Store edition. Windows manages Store removal and removes its package-scoped data; the external Saved Games data remains.

Logs, caches and WebView data are stored separately for each installation in AppData. Start-at-login is also configured separately. If both official installations start, the first one keeps running.

See [Data and Permissions](PRIVACY.md) for details and removal options.

## Questions and Bug Reports

Use [GitHub Issues](https://github.com/d-meloper/dmelopers-block-pet/issues) for questions, bugs and suggestions. Include:

- App version and whether you use GitHub, Microsoft Store or a source build.
- Whether this was a new installation, update or reinstall; include the previous version if applicable.
- Installer filename, Windows version and display scaling.
- Steps to reproduce the problem, what you expected and what happened.

You can attach the relevant part of a diagnostic log. Remove personal paths, skins, nicknames, tokens and other private information first.

Report vulnerabilities privately using the [Security policy](SECURITY.md).
