# Security Policy

[한국어](https://github.com/d-meloper/dmelopers-block-pet/blob/main/docs/SECURITY.ko-KR.md) · English

## Reporting a Vulnerability

Use [GitHub private vulnerability reporting](https://github.com/d-meloper/dmelopers-block-pet/security/advisories/new). Include the affected version, distribution channel, impact and steps to reproduce the problem.

Remove personal information from any attached evidence. Keep credentials and exploit details out of public issues.

Microsoft Store distribution is being prepared. Include the application version or source commit in reports.

Security fixes target the latest published stable version on x64 Windows 10 22H2 with the September 2023 cumulative update (build 19045.3448) or later, and Windows 11 22H2 with the September 2023 cumulative update (build 22621.2283) or later. Windows 11 24H2 or newer is recommended. GitHub and Store are configured to use the same product version, `X.Y.Z`; the Store package version is `X.Y.Z.0`.

## Downloads and Signatures

Official GitHub updates check signed information from the official repository. Before installation, the app verifies the installer size, SHA-256 and detached Tauri signature. Separate WiX test editions use their own fixed source and signing key.

The initial GitHub installer does not have an Authenticode signature, so Windows may show an unknown publisher. A Tauri `.sig` signature is separate from Authenticode and does not establish Windows publisher reputation.

An Edge “isn't commonly downloaded” message is a reputation warning. That message alone does not mean a file is malicious or safe. If security software reports malware, stop and report the exact warning.

Microsoft manages Store package signing and updates. The installed package signed by Microsoft can have a different hash from the submitted package.

## Checking a Download

Installer release notes list the SHA-256 of each file under Checksums. In PowerShell, use `Get-FileHash -Algorithm SHA256 -LiteralPath '<downloaded file>'` to check each downloaded file before running the installer.

A matching hash confirms that the bytes match. It does not, by itself, establish safety or the publisher's identity. If a hash differs, do not run the file; report the mismatch.

For more information, see Microsoft's [SmartScreen FAQ](https://feedback.smartscreen.microsoft.com/smartscreenfaq.aspx) and [code signing guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options).

## Installation Problems

WiX installations use Windows Installer rollback for program-file changes. This does not restore personal data from an earlier backup; automatic app-data rollback is not provided. If installation is interrupted, run the same installer again to repair the program files. Normal installation and repair preserve shared Saved Games data. Removing personal data is a separate confirmed uninstaller option; see [Data and Permissions](https://github.com/d-meloper/dmelopers-block-pet/blob/main/docs/PRIVACY.md) for its scope.

Review logs before sharing them. See [Support](https://github.com/d-meloper/dmelopers-block-pet/blob/main/docs/SUPPORT.md) for installation help.
