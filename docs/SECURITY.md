# Security Policy

Report vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/d-meloper/dmelopers-block-pet/security/advisories/new). Include the affected version, impact, reproduction steps and sanitized evidence. Do not post exploit details or secrets in public issues.

Security fixes target the latest published stable version for Windows 11 24H2 or newer, x64. Update to the latest stable release before repeating a report.

Download installers from the official Releases page linked by the app. Each release provides the installer, its detached Tauri signature (`.sig`), and SHA-256 checksums for both files. Updates are installed manually; the app does not fetch or execute update packages. The first release has no Authenticode signature, so Windows may display an unknown-publisher prompt. A checksum detects changed bytes but does not itself authenticate the publisher.
