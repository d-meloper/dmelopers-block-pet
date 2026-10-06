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

- A 3D pet that responds to keyboard input, mouse movement and clicks
- Skins from 64×64 or legacy 64×32 PNGs and Minecraft Java Edition nicknames
- Adjustable head size, pet rotation, arm bend and spread, eyebrow shape and color, and palm color
- Zoom, rotation, opacity, mirror, and automatic or manual display-area sizing
- Desk size, height, color and transparency, plus keyboard and mouse position, size and colors
- Presets with previews, favorites, duplication, custom ordering, and `.petpreset` import and export

## Download

Download the app from the page below.

[GitHub Releases](https://github.com/d-meloper/dmelopers-block-pet/releases)

For a direct GitHub installation, run the `.exe` installer. The accompanying `.sig` is a verification file and is not required for normal installation. Check the published release notes for changes and the installer's SHA-256. [Security](docs/SECURITY.md) explains download warnings and signature verification.

Microsoft Store distribution is being prepared. A Store link will be published when the app is available.

## Requirements

- Windows 10 22H2, build 19045.3448 or later, x64
- Windows 11 22H2, build 22621.2283 or later, x64
- Microsoft Edge WebView2 Runtime

- Recommended: Windows 11 24H2, build 26100 or later, x64

No macOS, Linux or Windows ARM edition is provided.

## Basic Usage

The App Notion page and customization guide explain installation, skins, customization, presets and OBS setup.

- [App Notion page](https://app.notion.com/p/aismash/DMeloper-s-Block-Pet-0da2dc0bb4ae82ab8db301718dde497b?source=copy_link)
- [Customization guide](https://app.notion.com/p/84f2dc0bb4ae83c6a5c28193dca38b20)

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

- [FAQ](https://app.notion.com/p/6a62dc0bb4ae8219902f81f8e89cbc28)
- [Known Issues](https://app.notion.com/p/d5e2dc0bb4ae82a7ac9a01e543e1c84a)

Use the form below for usage questions, bug reports and feature suggestions.

[DMeloper's Block Pet Support Form](https://aismash.notion.site/9cff9655595342d78a22c17b61a2084c)

You can also report problems through [GitHub Issues](https://github.com/d-meloper/dmelopers-block-pet/issues). Read [Contributing](docs/CONTRIBUTING.md) before opening a pull request for code, documentation or translation changes.

When reporting a bug, copy your environment details from `About > App Info` and attach them to help identify the cause.

## Support

- Bugs and feature requests: [Support form](https://aismash.notion.site/9cff9655595342d78a22c17b61a2084c), [GitHub Issues](https://github.com/d-meloper/dmelopers-block-pet/issues)
- Code, documentation and translations: [Contributing](docs/CONTRIBUTING.md)
- Data and permissions: [Data and Permissions](docs/PRIVACY.md)
- Security reports: the private reporting procedure in [Security](docs/SECURITY.md)

## Credits

- App creator: [DMeloper](https://litt.ly/dmeloper)
- Portions of the original code: [ayangweb/BongoCat v1.1.0](https://github.com/ayangweb/BongoCat/tree/v1.1.0)
- UI icons: [Solar Icons](https://icon-sets.iconify.design/solar/), [Lucide Icons](https://lucide.dev/), [Ant Design Icons](https://github.com/ant-design/ant-design-icons)

[Third-party notices](docs/THIRD_PARTY_NOTICES.md) provide copyright and license details for these projects and assets.

## License And Rights Notice

The application source is licensed under [MIT](LICENSE). Original code copyrights and third-party asset and dependency notices remain in effect. DMeloper's Block Pet is an independent project derived from portions of BongoCat and is not an official BongoCat distribution.

This is not an official Minecraft product and has no approval, affiliation or sponsorship from Mojang Studios or Microsoft. Minecraft trademarks, names and copyrights belong to their respective owners.
