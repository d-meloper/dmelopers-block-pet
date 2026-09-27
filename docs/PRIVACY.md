# Privacy and permissions

This describes the implementation in the current source preview of DMeloper's Block Pet. Official installers and the Store listing are not yet published. The developer does not
operate an account service, telemetry endpoint, or automatic crash upload for
this version. Java Edition skin lookup and latest-version checks make the network
requests described below; the application should not be described as entirely offline.

## Keyboard and mouse activity

While enabled, global input monitoring observes key press/release, pointer
position, mouse buttons, and scrolling to animate the pet and its devices.
Native code temporarily tracks pressed keys and reduces keyboard events to
contact positions and typing intensity for the renderer. Typed text and an
input-history log are not saved or sent to a server by this feature. Pointer
coordinates and button state are processed locally. Quit the application to
stop its monitoring; optional mouse interaction can also be disabled in settings.

## Optional OBS browser output

Broadcast output is off by default. When enabled, an HTTP/WebSocket service
binds only to `127.0.0.1` on this computer. A browser source with the app's
connection address receives the current scene, its active PNG skin, and the
same animation events, including physical keyboard contact positions, press/release
states and their timing. A holder of the connection address can use these events
to infer keys or input activity. The app does not send composed text strings,
skin-library names, or other files. This feature does not use a public server. OBS or another
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
WebView data use each installation's separate AppData location. Test and development
installations use separate data. Skin images, thumbnails, filenames, nicknames and
settings are personal data.

Uninstall preserves shared Saved Games data. Delete library entries through the skin
library. Program reset clears settings and the library; it does not prove that all
caches and logs have been erased. Quit both official installations before manually
removing shared data, and preserve anything you want to keep. Selecting the default
skin alone does not erase the library.

## Logs, clipboard, and system integration

The About page opens the local log directory. Diagnostic errors can reveal
environment details or file paths; review logs before sharing them. Do not post
raw logs, local data directories, personal skins, nicknames, or credentials in
public issues. There is no automatic log upload. Log rotation and retention
follow the bundled logging component and should not be assumed to erase data
immediately on exit or reset.

Copying app information writes app/runtime versions and OS details to the
clipboard after a button click. The app also uses window management, configured
global shortcuts, and optional start-at-login integration for its desktop
features. Start-at-login can be disabled in settings.

The Windows installer checks for Microsoft WebView2 and asks you to install it manually if it is absent; it does not download or run a bootstrapper. Opening
an external link launches the user's browser and is subject to that site's
privacy practices. GitHub downloads, issues, and vulnerability reporting are
GitHub services, separate from the running application.

For confidential security reports, follow [SECURITY.md](SECURITY.md). General
support instructions are in [SUPPORT.md](SUPPORT.md).

## Program version management and local data

In the official GitHub channel, opening Settings checks signed update metadata at
`raw.githubusercontent.com/d-meloper/dmelopers-block-pet/updates/tauri-stable.json`
and its detached signature. A successful check is cached for six hours and an error
for ten minutes; the manual check button requests a fresh check. GitHub receives the
request and network address. The request includes no settings, skins, input history,
broadcast address or device identifier. Version metadata and error timing are cached
locally. Installing starts only after your click and downloads the verified installer
from the fixed official GitHub release. Cancellation is available until settings saving
begins. Program update backups and automatic rollback are not provided. After an
interruption, close the app and run the same installer again to repair program files.

The Microsoft Store installation uses Windows-managed updates and an Open Store
button; it does not request the GitHub update feed or display-only GitHub version feed. Opening the Store button contacts Microsoft through the Store application. Both installations retain the same core
input, pet and OBS features. Start-at-login is configured per installation; the first
official instance started keeps running. Preset import retains its own recovery record
until completion or recovery; whole-app data export and import are not provided.
