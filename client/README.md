# StellarDNS Client

Encrypted DNS for a machine that leaves the house: a loopback resolver that speaks DoH or DoT
upstream, applies the same blocklists as the server, and answers from a local cache.

```
client/
  src/config.js      per-OS config file and defaults
  src/doh.js         RFC 8484 DoH and RFC 7858 DoT transports
  src/blocklist.js   hosts/adblock parser and suffix matcher
  src/proxy.js       the resolver: cache, filter, forward
  src/sysdns.js      point the OS at 127.0.0.1, and put it back
  src/gui.js         loopback HTTP server for the UI
  src/cli.js         the command set below
  public/index.html  the one UI all three shells render
  packaging/appimage/  AppRun, .desktop, build.sh
  windows/StellarDNS.Client/  WebView2 + WPF host
  macos/             Swift package, SwiftUI + Metal
```

## Use

```sh
node src/cli.js run                 # resolver + GUI on 127.0.0.1:53 / :5381 (needs root for :53)
node src/cli.js run --port 5353     # no privileges needed
node src/cli.js status
node src/cli.js test example.com A  # resolve through the encrypted upstream, show timing
node src/cli.js block ads.example.com
node src/cli.js unblock ads.example.com
node src/cli.js refresh             # re-download blocklists now
node src/cli.js import http://192.168.1.10:5380 --token TOKEN --all
node src/cli.js import http://192.168.1.10:5380 --token TOKEN --categories steam,xboxlive --allowlist
node src/cli.js set-dns             # point the OS at 127.0.0.1 (previous value saved)
node src/cli.js restore-dns
node src/cli.js install-service     # systemd user unit on Linux, printed equivalent elsewhere
```

Config lives at `%ProgramData%\StellarDNS\client.json` (Windows),
`~/Library/Application Support/StellarDNS/` (macOS), or
`~/.config/stellardns-client/` (Linux). Set `STELLARDNS_CLIENT_HOME` to override.

## Rules from a StellarDNS server

The GUI's **Rules from a server** panel can find a server on the LAN, preview everything it
publishes, and copy only the parts you tick:

- **Discover** sweeps the /24 of each non-loopback interface for `/api/client/ping` and lists
  what answered, with version. Nothing is trusted beyond that reply.
- **Preview** reads `/api/client/rules` with your API token (the token stays on this machine's
tmp side — the browser page never sends it anywhere; the client's own loopback API performs
the request).
- **Import selected** saves your selection into `client.json`: category rewrites (with their
  cache targets), blocklist URLs, and the server's allowlist. It is written locally and the
  server is not contacted again until the next import.

Imported categories are **stored, not applied**. The preview starts with every category
unchecked and *Apply these rewrites on this machine* off, and turning it on is a separate
decision from importing (you can also flip it later in Options → Rewrites). With rewrites off,
names resolve upstream as usual — the targets just sit in `client.json` until you enable them.
That is deliberate: an import should never be the reason a game stops working. A category
imported while disabled stays disabled either way.

CLI equivalent:

```sh
stellardns-client import http://192.168.1.10:5380 --token TOKEN --all
stellardns-client import http://192.168.1.10:5380 --token TOKEN --categories steam --lists
stellardns-client rewrites status      # are imported rewrites live?
stellardns-client rewrites on          # decide, independently of any import
```

`import` never enables rewrites; pass `--rewrites` to opt in for that one command. `--all`
still imports every category — it just leaves them inert.

The server side is `GET /api/client/ping` (unauthenticated, version only) and
`GET /api/client/rules` (token or admin session required). Both routes are new in v25.

A server older than v25 cannot serve rules at all: it has no `/api/client/rules`, and its auth
gate answers 401 to any `/api/` path it does not know. Discovery identifies it from
`/api/version` (which is unauthenticated on both releases) and lists it as *rules need v25*,
and Preview names the version it found — including when the token is wrong, because on that
server no token would have helped. Upgrade the server to v25 to use the import.

## Options

The GUI exposes listen port, encrypted upstream preset (Cloudflare, Quad9, Mullvad, AdGuard,
DoH or DoT), block response (`NXDOMAIN` or `0.0.0.0`), cache size, TTL floor and ceiling,
system-DNS management, the allowlist, and blocking on/off. Changes apply on save; upstream and
listen changes report that a restart is needed rather than pretending to take effect.

## First run: one question about DNS

After install, the first launch asks whether this machine should use StellarDNS for DNS.
Nothing is applied until you click **Use StellarDNS**, and **Not now** is remembered, so it
asks once rather than nagging.

- The current resolvers are read and written to config **before** the change, so there is a
  record to restore from. `restore-dns`, the Options toggle, or uninstalling the setting puts
  them back.
- On Windows a standard user cannot change an adapter's DNS; the client retries through the UAC
  prompt and verifies the result with `Get-DnsClientServerAddress`, rather than reporting success
  from an exit code. Declining the prompt is reported as declined, not as a failed change.
- The adapter is the one holding the best default route (lowest `RouteMetric + InterfaceMetric`,
  and `Up`) — not the lowest interface index, and not one called `Wi-Fi`. Docks, VPN clients and
  virtual switches all break that assumption; the lowest index is often a disconnected adapter
  that still carries a route.
- Both families point at the loopback: `127.0.0.1` and, when the adapter has an IPv6 gateway,
  `::1`. A router that advertises its own IPv6 resolver would otherwise answer first and the
  filter would never see the query.
- If nothing is listening, nothing resolves. The prompt says so, and it also refuses to appear
  when the encrypted upstream cannot answer: taking over DNS and then losing the upstream is
  how a filtering client takes a machine offline instead of cleaning it up.

## Windows installer

```powershell
cd client\windows\installer\wix
.\build-msi.ps1 -Runtime win-x64     # -> client\windows\dist\StellarDNS-26.0.0-x64.msi
```

Per-machine MSI into `%ProgramFiles%\StellarDNS` with a Start Menu shortcut, silent install
and uninstall (`msiexec /i ... /qn`, `msiexec /x ... /qn`), and a major-upgrade rule so a newer
version replaces an older one instead of stacking. It installs no service and changes no DNS
setting — both stay explicit actions inside the app, for the same reason rewrites are opt-in.

WiX is pinned to v5 in `installer\wix\.config\dotnet-tools.json`; v6+ refuses to build until
the Open Source Maintenance Fee EULA is accepted, and that is not a decision a build script
should make for you. The MSI is the only installer: one definition, rebuildable from a clean
checkout, with no InstallShield project to keep in sync.

## What is verified

- `node client/test/e2e.js` — resolver, DoH transport, filtering, cache, allowlist override,
  NXDOMAIN wire shape, GUI endpoints, the loopback guard, and the first-run DNS prompt with a
  stubbed sysdns, including the refusal to apply off port 53 (so the suite never repoints
  this machine). 28 checks.
- `node client/test/dot.js` — a stalled DoT handshake is discarded and the next query opens a
  new connection instead of queueing forever. 1 check.
- `node client/test/import.js` — boots the real `server.js`, then exercises discovery, token
  rejection, ruleset shape, selection, the rewrite path (including subdomains, the inert  default and disabled categories), the GUI preview/import endpoints, and a pre-v25 server
  being identified rather than reported as an empty network. 25 checks.
- `node --check` passes on every source file.

## What is not built here

- **Windows**: built and packaged here. `windows/publish.ps1` produced `dist/win-x64`, and
  `windows/installer/wix/build-msi.ps1` produced
  `dist/StellarDNS-26.0.0-x64.msi` (85,958,545 bytes; SHA-256
  `43B936ABE4564895732808A79324FABB53413841FB827199E7522B35470D59E5`). Administrative extract
  confirms every payload file expands without running any custom action: the core reports
  26.0.0, the v26 user agent and UI escaping helper are present, and `core\node.exe` is 85.7 MB.
  The build is self-contained, so the target needs neither .NET nor Node. This v26 MSI was not
  installed or launched in this pass, so the installed UI and DNS flow were not re-tested.
- **macOS**: `macos/` is a Swift package with a SwiftUI + Metal shell. It needs Xcode; it has
  not been compiled. The Metal view draws the query plot with Core Graphics today and keeps a
  `MTLDevice` for the GPU path.
- **AppImage**: `packaging/appimage/build.sh` produces one, but it has not been run in this
  environment. It needs `appimagetool` (it downloads it) and a Linux host.

The native shells are deliberately thin: they start the Node core, wait for
`http://127.0.0.1:5381/api/state`, and show the shared UI. Replacing them with Rust later does
not require rewriting the UI or the resolver behaviour.
