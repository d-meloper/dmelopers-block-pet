# Privacy and permissions

This describes the current DMeloper's Block Pet application. The developer does not
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
same semantic animation events. It does not receive typed text, skin-library
names, or other files. This feature does not use a public server. OBS or another
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

Settings and the `skin-library` directory belong to the application's data
directory. The `minecraft-skins` cache belongs to its cache directory. These
directories use the application identifier `com.dmeloper.blockpet`; their parent
location depends on the operating system. They can contain skin images,
thumbnails, filenames, nicknames, and settings and should be treated as personal
data when sharing a computer or a backup.

Delete saved library entries through the skin library. The program reset clears
settings and the saved library; it should not be treated as proof that every
cache or diagnostic log has been erased. To remove residual data, quit the app
and remove its own data, cache, and log directories after checking their paths
and backing up anything you want to keep. Selecting the default skin alone does
not erase the library. Uninstall retention and exact Windows removal steps must
be verified for each published installer and documented in its release notes.

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

At app start and when you open About, the app checks a small static JSON file at
`raw.githubusercontent.com/d-meloper/dmelopers-block-pet/badges/badge-data.json`.
GitHub receives that request and the network address used to reach it; its privacy
practices apply. The request sends no app settings, input history, skins, broadcast
address or device identifier. A successful result is cached locally for six hours;
failed checks are retried no more often than every ten minutes. The cache contains
public version and file metadata, validation times and error status. The app uses
it only to display version information, and does not download or run an installer.

In Settings > About, **Open latest version link** opens the fixed official Releases
page in your browser. Those browser requests also follow GitHub's privacy practices.

Close the app and manually reinstall into the recorded folder to keep settings, presets and skins. Program-update backups and automatic rollback are not provided. Preset import still retains its own local recovery record until the import is confirmed or recovered; whole-app data export and import are not provided.
