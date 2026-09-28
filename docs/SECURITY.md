# Security Policy

Report vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/d-meloper/dmelopers-block-pet/security/advisories/new). Include the affected version, channel, impact, reproduction steps and sanitized evidence. Keep secrets and exploit details out of public issues.

Security fixes target the latest published stable version for Windows 11 24H2 or newer, x64. GitHub and Store use the same product version (X.Y.Z; the Store package is X.Y.Z.0).

GitHub updates check signed metadata from the fixed official repository and verify the installer size, SHA-256 and detached Tauri signature before user-initiated installation. A Tauri signature is separate from Authenticode. Initial GitHub installers have no Authenticode signature and Windows may show an unknown publisher. A checksum detects changed bytes; it does not alone authenticate the publisher. Microsoft manages Store package signing and updates; the Microsoft-signed installed package can differ from the submitted package hash.

Installation failures preserve shared Saved Games data. Repair an interrupted GitHub installation using the same installer; automatic rollback is not provided. Review logs before sharing them. This independent personal project does not claim SignPath signing or CI-produced official release binaries.
