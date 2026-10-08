<p align="center">
  <img src="assets/hero.png" alt="DMeloper's Block Pet hero image" width="36%">
</p>

# DMeloper's Block Pet

English | [한국어](README.ko-KR.md)

<p align="center">
  <a href="https://github.com/d-meloper/dmelopers-block-pet/releases/latest"><img alt="Latest release" src="https://raw.githubusercontent.com/d-meloper/dmelopers-block-pet/badges/release.svg"></a>
  <a href="https://github.com/d-meloper/dmelopers-block-pet/releases"><img alt="Downloads" src="https://raw.githubusercontent.com/d-meloper/dmelopers-block-pet/badges/downloads.svg"></a>
  <a href="https://github.com/d-meloper/dmelopers-block-pet/stargazers"><img alt="GitHub stars" src="https://raw.githubusercontent.com/d-meloper/dmelopers-block-pet/badges/stars.svg"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://raw.githubusercontent.com/d-meloper/dmelopers-block-pet/badges/license.svg"></a>
</p>

DMeloper's Block Pet is a Minecraft-style desktop pet for Windows that reacts to your keyboard and mouse.

Change the pet's skin, save your settings as presets and export them. Customize the pet, surrounding objects, display and lighting, and bring the pet into your OBS stream.

## Main Features

- **A 3D pet that responds to keyboard input, mouse movement and clicks**

  <p align="center">
    <img src="assets/features/input-mouse.gif" alt="Keyboard and mouse reactions" width="35%">
    &nbsp;&nbsp;
    <img src="assets/features/input-keyboard.gif" alt="Keyboard-only reactions" width="35%">
  </p>

  <br>

- **Skins from 64×64 or legacy 64×32 PNGs and Minecraft Java Edition nicknames**

  <p align="center">
    <img src="assets/features/skin-selection.gif" alt="Selecting Minecraft skins" width="400">
  </p>

  <br>

- **Adjustable head size, pet rotation, arm bend and spread, eyebrow shape and color, and palm color**

  <p align="center">
    <img src="assets/features/pet-customization.gif" alt="Customizing the pet appearance" width="400">
  </p>

  <br>

- **Zoom, rotation, opacity, mirror, and automatic or manual display-area sizing**

  <p align="center">
    <img src="assets/features/display-customization.gif" alt="Customizing the display area" width="400">
  </p>

  <br>

- **Desk size, height, color and transparency, plus keyboard and mouse position, size and colors**

  <p align="center">
    <img src="assets/features/object-customization.gif" alt="Customizing desk, keyboard and mouse" width="400">
  </p>

  <br>

- **Presets with previews, favorites, duplication, custom ordering, and `.petpreset` import and export**

  <p align="center">
    <img src="assets/features/presets.gif" alt="Applying saved presets" width="520">
  </p>

## Download

##### Microsoft Store (Windows 10 build 19045.3448+ / Windows 11 build 22621.2283+, x64)

<a href="https://apps.microsoft.com/detail/9PLKW6NBMKQ7?hl=en-US" target="_self">
  <img src="https://get.microsoft.com/images/en-us%20dark.svg" alt="Download from Microsoft Store" width="200">
</a>

#### ⚠️ Important

Installing from the Microsoft Store avoids the SmartScreen download and unrecognized-publisher warnings described below. After a new version is released, however, it **may take up to 3 business days** to appear on the Store.

If you want to download the latest version before it reaches the Store, or get new releases promptly through the app's built-in updater, download the GitHub edition below.

<a name="installation-warnings"></a>

<details>
<summary><strong>This program is not a virus 🛡️ · Warning explanations and workarounds</strong></summary>

When you try to install the program, your web browser may restrict the download or a security program may run a quarantine scan, as shown below.

<p align="center">
  <img src="assets/install-warnings/en/edge-download-warning.png" alt="Microsoft Edge download warning" width="28%">
  &nbsp;
  <img src="assets/install-warnings/en/smartscreen-more-info.png" alt="Windows SmartScreen execution warning" width="28%">
  &nbsp;
  <img src="assets/install-warnings/en/v3-isolation-scan.png" alt="AhnLab V3 Lite app quarantine scan" width="28%">
</p>

### Q1. Why do these warnings appear?

**A1. The program has few downloads**<br>
A newly released version has not been downloaded many times, so it may be treated as an unverified program and trigger a warning as a precaution.

**A2. The program is not code-signed**<br>
The program does not have a publisher signature identifying its developer, so a warning may appear as a precaution.

### Q2. Why is the program not code-signed?

**A. Code signing involves recurring costs**, so this free program has been distributed without code signing. To reduce these warnings, [**Azure Artifact Signing**](https://azure.microsoft.com/en-us/products/artifact-signing/) is being considered as of October 8, 2026. Eligibility must first be checked, and setting up a website and completing the review process are expected to take at least about a month. Warnings may continue to appear until then.

If you are uncomfortable with the workarounds below, install the program through the [official DMeloper’s Block Pet Microsoft Store page](https://apps.microsoft.com/detail/9PLKW6NBMKQ7?hl=en-US). These warnings do not appear when installing through this route.

### Warning workarounds

#### If Microsoft Edge warns during the download

1. Click **[···] → [Keep]**.

<p align="center">
  <img src="assets/install-warnings/en/edge-keep.png" alt="Keep in the Microsoft Edge download menu" width="360">
</p>

2. Click **[⌵]** next to **[Delete]**, then **[Keep anyway]**.

<p align="center">
  <img src="assets/install-warnings/en/edge-keep-anyway.png" alt="Keep anyway in Microsoft Edge" width="280">
</p>

3. Done.

#### If SmartScreen warns when running the installer

1. Click **[More info]**.

<p align="center">
  <img src="assets/install-warnings/en/smartscreen-more-info.png" alt="More info in Windows SmartScreen" width="360">
</p>

2. Click **[Run anyway]**.

<p align="center">
  <img src="assets/install-warnings/en/smartscreen-run-anyway.png" alt="Run anyway in Windows SmartScreen" width="360">
</p>

3. Done.

### Antivirus workaround

After the quarantine scan finishes, select **[Run once]** or **[Run after excluding File Hash]** under **[Specify an action to take]**, then run the program.

<p align="center">
  <img src="assets/install-warnings/en/v3-file-actions.png" alt="AhnLab V3 Lite unknown new file notice and file-handling options" width="330">
</p>

</details>

[GitHub Releases](https://github.com/d-meloper/dmelopers-block-pet/releases)

For a direct GitHub installation, run the `.exe` installer. The accompanying `.sig` is a verification file and is not required for normal installation. Check the published release notes for changes and the installer's SHA-256. [Security](docs/SECURITY.md) explains download warnings and signature verification.

## Requirements

- Windows 10 22H2, build 19045.3448 or later, x64
- Windows 11 22H2, build 22621.2283 or later, x64
- Microsoft Edge WebView2 Runtime 120 or later

- Recommended: Windows 11 24H2, build 26100 or later, x64

The GitHub installer installs WebView2 when needed; this step requires an internet connection.

No macOS, Linux or Windows ARM edition is provided.

## Basic Usage

For installation, skins, presets and OBS setup, see the [App Notion page](https://aismash.notion.site/DMeloper-s-Block-Pet-Global-3f32dc0bb4ae807987f5df0a0f1b112e).

Current settings are saved automatically. Use `Presets > +New Preset` to keep a configuration.

## Troubleshooting

Check the following first.

- If the pet is hidden, check `Show Pet` in the tray menu and `Show Pet on My Desktop` in broadcast settings.
- If the pet cannot be clicked or dragged, turn off `Pass Through` in the tray menu.
- If a skin fails to apply, check the PNG format, 64×64 or 64×32 dimensions, Java Edition nickname and internet connection.
- If OBS shows no pet, check that the app is running, broadcast output is enabled and the address is correct, then refresh the browser source.
- If a problem persists, quit fully with `Quit App` in the tray menu and launch the app again.
- Report errors through `About > Contact Us`.

[Support](docs/SUPPORT.md) covers installation and repair. [Data and Permissions](docs/PRIVACY.md) covers data retention and deletion.

## Contact / Bug Reports / Contributions

Before submitting a question or bug report, check these pages.

- [FAQ](https://aismash.notion.site/Frequently-Asked-Questions-3f32dc0bb4ae803e8b19f07c81c4fd26)
- [Known Issues](https://aismash.notion.site/Known-Issues-3f32dc0bb4ae80bc9f06e05113f06c5c)

Use the form below for usage questions, bug reports and feature suggestions.

[DMeloper's Block Pet Support Form](https://aismash.notion.site/5402dc0bb4ae83fdb83681271f4b937e?pvs=105)

You can also report problems through [GitHub Issues](https://github.com/d-meloper/dmelopers-block-pet/issues). Read [Contributing](docs/CONTRIBUTING.md) before opening a pull request for code, documentation or translation changes.

When reporting a bug, copy your environment details from `About > App Info` and attach them to help identify the cause.

## Support

- Bugs and feature requests: [Support form](https://aismash.notion.site/5402dc0bb4ae83fdb83681271f4b937e?pvs=105), [GitHub Issues](https://github.com/d-meloper/dmelopers-block-pet/issues)
- Code, documentation and translations: [Contributing](docs/CONTRIBUTING.md)
- Data and permissions: [Data and Permissions](docs/PRIVACY.md)
- Security reports: the private reporting procedure in [Security](docs/SECURITY.md)

## Credits

- App creator: [DMeloper](https://litt.ly/dmeloper)
- Portions of the original code: [ayangweb/BongoCat v1.1.0](https://github.com/ayangweb/BongoCat/tree/v1.1.0)
- UI icons: [Solar Icons](https://icon-sets.iconify.design/solar/), [Lucide Icons](https://lucide.dev/), [Ant Design Icons](https://github.com/ant-design/ant-design-icons)

[Third-party notices](docs/THIRD_PARTY_NOTICES.md) provide copyright and license details for these projects and assets.

## License And Rights Notice

The application source and DMeloper-authored base 3D model, default PNG skin, and application icon (including its generated variants) are licensed under [MIT](LICENSE). MIT permits modification, redistribution, and commercial use while retaining the copyright and permission notice. Original code copyrights and third-party asset and dependency notices remain in effect. DMeloper's Block Pet is an independent project derived from portions of BongoCat and is not an official BongoCat distribution.

This is not an official Minecraft product and has no approval, affiliation or sponsorship from Mojang Studios or Microsoft. Minecraft trademarks, names and copyrights belong to their respective owners.
