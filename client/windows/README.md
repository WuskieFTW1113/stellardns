# StellarDNS Client — Windows

A WPF window hosting WebView2, which shows the shared client UI served by the Node core on
`127.0.0.1:5381`. The shell does three things: start the core, wait for that port, and put the
page in the window. Closing the window hides it to the tray; **Exit** restores DNS before it
stops the core.

## Requirements

- Windows 10 1809+ or Windows 11
- [WebView2 Evergreen runtime](https://developer.microsoft.com/microsoft-edge/webview2/) — already
  present on current Windows installs
- Nothing else: `publish.ps1` bundles `node.exe` and the .NET runtime into the output

## Build

```powershell
cd client\windows\StellarDNS.Client
dotnet build -c Release
```

The build copies the Node core next to the executable, so the output folder is runnable:

```
bin\Release\net9.0-windows\
  StellarDNS.Client.exe
  WebView2Loader.dll
  core\src\cli.js        the resolver, DoH/DoT, GUI server
  core\public\index.html the page the window renders
  core\node_modules\dns-packet
```

## Publish

```powershell
cd client\windows
.\publish.ps1                        # win-x64  -> dist\win-x64
.\publish.ps1 -Runtime win-arm64     # ARM64    -> dist\win-arm64
.\publish.ps1 -FrameworkDependent    # needs the .NET 9 runtime on the target
```

Each result is a folder you can zip. It is self-contained by default and always carries
`core\node.exe`, so the target needs neither .NET nor Node installed. `-NodeExe` overrides
which `node.exe` is bundled; without it the one on `PATH` is used, and the build fails rather
than producing a folder that cannot resolve.

## Installer

```powershell
cd client\windows\installer\wix
.\build-msi.ps1 -Runtime win-x64
# -> client\windows\dist\StellarDNS-26.0.0-x64.msi
```

The MSI installs per-machine into `%ProgramFiles%\StellarDNS`, adds a Start Menu shortcut, and
supports silent install and uninstall (`msiexec /i ... /qn`, `msiexec /x ... /qn`). It installs
no service and **does not touch DNS**; those are actions inside the app, deliberately. The
client asks about DNS on its first run and changes nothing unless you click yes.

WiX is pinned to v5 in `installer\wix\.config\dotnet-tools.json`: v6+ refuses to run until the
Open Source Maintenance Fee EULA is accepted. The MSI is the installer — there is no
InstallShield project to keep in sync and no commercial toolchain required to rebuild it. The
wizard keeps WiX's minimal flow (licence, confirm, progress, finish) but carries its own art
(`art\make-art.ps1` regenerates `banner.bmp` and `dialog.bmp`) and its own copy (`Strings.wxl`)
instead of the stock look. Both are plain files in this folder, so rebranding is a rebuild, not
a purchase.

## Running

Double-click `StellarDNS.Client.exe`. The core starts with `--no-dns`, so **nothing about your
system DNS changes until you say so** — the client listens on `127.0.0.1:53`, the GUI shows
stats, but no lookup is routed through it yet.

The first launch asks once, in the window: *Use StellarDNS for this machine?*

- **Use StellarDNS** saves your current resolvers to config, then points the adapter with the
  default route at `127.0.0.1` (and `::1` when the adapter has an IPv6 gateway) through the UAC
  prompt, and reads the result back with `Get-DnsClientServerAddress` to confirm it took.
  Choosing the default-route adapter matters: on a laptop with a dock, the lowest `ifIndex` is
  often a virtual switch, and changing that one changes nothing.
- The prompt refuses to appear when the encrypted upstream cannot answer. A client that takes
  over DNS and then cannot reach its resolver takes the machine offline.
- **Not now** is remembered. It does not ask again on later launches.
- The prompt is disabled, with the reason shown, when the resolver is not listening on port 53 —
  pointing Windows at a dead listener would take the whole machine offline.

Either answer is reversible. Options → *Use StellarDNS for system DNS* applies or restores the
saved resolvers, and the CLI does the same from an elevated prompt:
`node core\src\cli.js set-dns` and `restore-dns`.

## Tray icon

The window does not have to stay open. Closing it hides to the notification area and the
resolver keeps running — a machine whose DNS points at the client would otherwise be left
resolving against a dead port. Double-click the icon to bring the window back, or right-click
for the four actions:

- **Open StellarDNS** — restore the window.
- **Blocking: on / paused** — flips the same switch the Filtering panel does, without opening it.
- **Restore system DNS** — enabled only while the client is actually managing DNS; puts the
  saved resolvers back.
- **Exit** — restores DNS if it is managed, then stops the core and leaves.

The icon comes from `installer\wix\art\make-icon.ps1`, which writes
`StellarDNS.Client\Assets\app.ico` (nine sizes, 16 px to 256 px — each rendered at its own
resolution rather than downscaled). It is embedded in the executable, so the window, taskbar,
tray and Programs and Features all show it instead of a generic .NET glyph. Regenerate with:

```powershell
cd client\windows\installer\wix\art
.\make-icon.ps1
```

## When it does not start

The core's output goes to `%TEMP%\stellardns-client.log`. If the window shows
"The resolver core is missing", the `core\` folder was not copied — rebuild rather than copying
the exe alone. If it shows "did not answer", that log has the reason (usually port 5381 already
in use, or Node missing).

The shell keeps WebView2's browser profile in `%LOCALAPPDATA%\StellarDNS\WebView2`, not in the
install folder. If the window says the WebView2 runtime is missing and the detail is
`E_ACCESSDENIED`, the runtime is present but could not create that profile — check the path is
writable by the current user before reinstalling anything.

## What is verified

- `publish.ps1 -Runtime win-x64` completed under .NET 9 and WebView2 1.0.2592.51, including
  the self-contained core probe outside the repository; `cli.js version` reported 26.0.0.
- `build-msi.ps1 -Runtime win-x64` produced `dist\StellarDNS-26.0.0-x64.msi` (85,958,545
  bytes; SHA-256 `43B936ABE4564895732808A79324FABB53413841FB827199E7522B35470D59E5`).
- Administrative extract confirms the payload expands, `core\package.json` is 26.0.0,
  `core\src\doh.js` carries the v26 user agent, `core\public\index.html` has the new escaping
  helper, and `core\node.exe` is present (85.7 MB).

Not verified: this v26 MSI was not installed or launched, so the window, tray and DNS flows
were not exercised on a machine; the UI was not visually inspected. The ARM64 build was not
rebuilt in this pass.
