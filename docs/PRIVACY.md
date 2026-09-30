# Data and Permissions

[한국어](PRIVACY.ko-KR.md) · English

This notice explains the data and permissions used by DMeloper's Block Pet.
The app has no account service, usage analytics or automatic crash-report uploads.
Java Edition skin lookup, update checks and external pages you open use network
connections as described below.

## Keyboard and mouse activity

While enabled, global input monitoring observes key press/release, pointer
position, mouse buttons, and scrolling to animate the pet and its devices.
The app temporarily tracks pressed keys and uses contact positions and typing
intensity to animate the pet. Typed text and an
input-history log are not saved or sent to a server by this feature. Pointer
coordinates and button state are processed locally. Quit the application to
stop input monitoring; optional mouse interaction can also be disabled in settings.

## Optional OBS browser output

Broadcast output is off by default. When enabled, an HTTP/WebSocket service
binds only to `127.0.0.1` on this computer. A browser source with the app's
connection address receives the current scene, its active PNG skin, and the
same animation events, including physical keyboard contact positions, press/release
states and their timing. A holder of the connection address can use these events
to infer keys or input activity. The app does not send the text you type, skin-library names, or other files. This feature does not use a public server. OBS or another
capture program controls any subsequent recording or streaming.

Hiding the desktop pet does not stop enabled broadcast output. Disabling
broadcast output disconnects its sources. The connection address contains a
random access token; copying the address writes it to the clipboard. Keep it
private from other local applications or people who should not use the source.
Its port and token are stored locally and retained by program reset so an OBS
source keeps the same address. Reset turns broadcast output off.

## Skins and network requests

A local PNG is read only after selection. The app stores a copy and thumbnail
in its local skin library, together with its display name, original filename
where available, arm model, and appearance settings. Selecting a local skin
does not upload it to the developer or a skin service.

Applying a Java Edition nickname sends it to `api.minecraftservices.com` (with
`api.mojang.com` as a supported fallback). The resulting public profile ID is
used at `sessionserver.mojang.com`, and the skin is downloaded over HTTPS from
`textures.minecraft.net`. Those services necessarily receive the request and
the network address used to reach them, which can be a proxy address. Their
own privacy policies apply. No Microsoft/Xbox login token or password is
requested. Bedrock identities and Marketplace content are not supported.

Verified skin bytes and the canonical nickname are kept locally for restoration.
The library can retain skins beyond the currently selected one. Raw downloaded
PNGs also use a separate cache capped at 32 MiB. Startup restores local data;
it does not automatically refresh a saved nickname from the network.

You can export one preset to a `.petpreset` file. Image mode includes the PNG,
its arm model, and any linked nickname; nickname mode includes the linked
nickname without a PNG or skin thumbnail. Both include the preset name and
pet, scene and object settings. Common settings, desktop position and internal
library IDs are excluded. Exporting does not contact the skin service. Importing
a nickname file performs the lookup described above once, then stores the PNG
locally for future use. Files are saved locally; the app does not upload them.
Review included images and nicknames before sharing a file yourself.

## Local data and removal

Official GitHub and Store installations share settings, presets and the skin library
under Saved Games\DMeloper's Block Pet. The first official instance keeps the shared
data open; another installation does not become a second writer. Logs, caches and
WebView data use each installation's separate AppData location.
Skin images, thumbnails, filenames, nicknames and
settings are personal data.

A normal GitHub uninstall preserves shared Saved Games and installation-specific data.
The GitHub uninstaller offers an unchecked “Remove all personal settings and files”
option. Selecting and confirming it removes `Saved Games\DMeloper's Block Pet`,
the GitHub edition's `%LOCALAPPDATA%` data (logs, caches and WebView data), and its
`%APPDATA%` data (configuration and update recovery records). It also removes the
shared settings, presets and skins used by an installed Store edition. If either
official edition is running, cleanup does not start; if a path or file cannot be
handled safely, uninstall stops. Windows
manages Store removal and removes its package-scoped data; the external Saved Games
data remains. Selecting the default skin alone does not erase the library.

## Logs, clipboard, and system integration

The About page opens the local log directory. New diagnostic file entries contain
categorized warnings and errors, operation names, error codes, limited source
locations, timestamps, app version, execution mode and process ID. They omit raw
error messages, settings, personal file paths, skins, nicknames and broadcast
connection addresses. Normal input activity is not logged.

The app appends to one local diagnostic file and limits repeated messages. It does
not automatically upload, rotate or delete that file, including on exit or reset.
Earlier entries can remain. Review any log excerpt before sharing it, and keep
personal paths, local data, skins, nicknames and credentials out of public issues.

Copying app information writes app/runtime versions and OS details to the
clipboard after a button click. The app also uses window management, configured
global shortcuts, and optional start-at-login integration for its desktop
features. Start-at-login can be disabled in settings.

The Windows installer checks for Microsoft WebView2 and asks you to install it
manually if it is absent. It does not download or run a WebView2 installer. Opening
an external link launches the user's browser and is subject to that site's
privacy practices. GitHub downloads, issues, and vulnerability reporting are
GitHub services, separate from the running application.

For confidential security reports, follow the [Security policy](SECURITY.md).
For general questions, see [Support](SUPPORT.md).

## Updates

In the official GitHub channel, opening Settings checks signed update metadata at
`raw.githubusercontent.com/d-meloper/dmelopers-block-pet/updates/tauri-stable.json`
and its detached signature. A successful check is cached for six hours and an error
for ten minutes; the manual check button requests a fresh check. GitHub receives the
request and network address. The request includes no settings, skins, input history,
broadcast address or device identifier. Version metadata and error timing are cached
locally. Installing starts only after your click and downloads the verified installer
from the fixed official GitHub release. Cancellation is available until settings saving
begins. The app does not back up program files for updates or automatically return to the previous version. After an
interruption, close the app and run the same installer again to repair program files.

The Microsoft Store edition uses Windows-managed updates. Its Open Store button
contacts Microsoft through the Store app. It does not request either the GitHub
update feed or the separate GitHub version information. Both editions provide
the same input, pet and OBS features. Start-at-login is configured per installation; the first
official instance started keeps running. Preset import retains its own recovery record
until completion or recovery; whole-app data export and import are not provided.
