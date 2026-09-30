# Security Policy

[한국어](SECURITY.ko-KR.md) · English

## Reporting a Vulnerability

Use [GitHub private vulnerability reporting](https://github.com/d-meloper/dmelopers-block-pet/security/advisories/new). Include the affected version, distribution channel, impact and steps to reproduce the problem.

Remove personal information from any attached evidence. Keep credentials and exploit details out of public issues.

Security fixes target the latest published stable version for Windows 11 24H2 or newer, x64. GitHub and Store use the same product version, `X.Y.Z`; the Store package version is `X.Y.Z.0`.

## Downloads and Signatures

GitHub updates check signed information from the official repository. Before installation, the app verifies the installer size, SHA-256 and detached Tauri signature.

Initial GitHub installers do not have an Authenticode signature, so Windows may show an unknown publisher. The accompanying Tauri `.sig` signature is separate from Authenticode and does not establish Windows publisher reputation.

An Edge “isn't commonly downloaded” message is a reputation warning. That message alone does not mean a file is malicious or safe. If security software reports malware, stop and report the exact warning.

Microsoft manages Store package signing and updates. The installed package signed by Microsoft can have a different hash from the submitted package.

## Checking a Download

Each release lists the SHA-256 of its files under Checksums. In PowerShell, use `Get-FileHash -Algorithm SHA256 -LiteralPath '<downloaded file>'` to check each downloaded file before running the installer.

A matching hash confirms that the bytes match. It does not, by itself, establish safety or the publisher's identity. If a hash differs, do not run the file; report the mismatch.

For more information, see Microsoft's [SmartScreen FAQ](https://feedback.smartscreen.microsoft.com/smartscreenfaq.aspx) and [code signing guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options).

## Installation Problems

Installation failures preserve shared Saved Games data. If a GitHub installation is interrupted, run the same installer again to repair the program files. Automatic rollback is not provided.

Review logs before sharing them. See [Support](SUPPORT.md) for installation help.
