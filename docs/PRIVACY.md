# Privacy and Data

[한국어](PRIVACY.ko-KR.md) · English

DMeloper's Block Pet privacy and data guidance is maintained on Notion.

- [Privacy Policy](https://aismash.notion.site/3f32dc0bb4ae803ea9aed8d3b366c391): information processing, external services, and privacy inquiries.
- [Data Management Guide](https://aismash.notion.site/3f32dc0bb4ae80808222e5e0cf123464): data storage, presets, reset and uninstall options, and contact form data.

## Pet Auto Hiding

Pet Auto Hiding is off by default. When enabled with registered apps and desktop pet display on, it checks the foreground window's executable path, window identifier, process ID and creation time, and visible/minimized state. Some Store apps also require a child window class check. Unregistered foreground apps can be checked for comparison. This feature does not capture the screen or read window titles, document contents, current browser tab addresses, or browsing history. Checks stop when you disable the feature, empty its list, turn off desktop pet display, or quit the app. They continue while the pet is automatically hidden. OBS output continues.

The app picker reads Windows app registrations, installed-package metadata, Start menu and desktop shortcuts, and program-shortcut metadata from the local Windows Search index. Names, icons, paths, shortcut targets, app identifiers, and launch options are processed in memory; selected executables' names and icons can also be reread to display registered apps. The app does not run or repair the shortcuts. It saves only the enabled state and registered executable paths in common settings under Saved Games, outside presets. Discovered lists, search terms, launch metadata, and foreground observations are not saved to the app's files or diagnostic logs, uploaded to the developer or analytics services, or sent to OBS sources. Network drives, shared folders, or redirected storage locations can involve their storage services in file selection, name/icon lookup, and saving settings. Those services' policies apply.

Disabling the feature, normal updates, and ordinary uninstalls retain registered paths. Removing an entry removes its path from the current list. Resetting auto hiding or General settings and Reset All Program Settings empty the list. The saved list changes after a successful settings save. The GitHub uninstaller's **Remove all personal settings and files** also removes the shared list used by the Store edition. See [Support](SUPPORT.md#pet-auto-hiding) for the choices. Paths and shortcut metadata can contain usernames or personal folder names, so check before sharing files or screenshots.
