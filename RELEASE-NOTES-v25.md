# StellarDNS v25 — Northstar

Two things ship here that people have been doing by hand: updating a resolver that lives in
another room, and getting the same DNS policy onto a laptop that leaves the house.

## Updates from the console

`Console → Updates` checks GitHub, shows the release body, installs on confirmation, and
restarts the service. There is no SSH step and no installer re-run for a normal upgrade.

What makes that safe enough to put behind a web login:

- **https only, four hosts.** `api.github.com`, `raw.githubusercontent.com`, `github.com` and
  the two asset hosts. The allowlist is enforced again on every redirect, not just the first
  request, because `https.get` will happily follow a `Location:` to anywhere.
- **16 MB cap** on every response, so a hostile or broken release cannot fill the disk.
- **`node --check` before the swap.** A release with a syntax error never replaces a working
  `server.js`. The check runs on the staged copy, and only a passing file is renamed into
  place.
- **A backup, and one-click rollback.** The files being replaced are copied to
  `data/update/backup-<version>/` with a `version.json`. `Roll back` restores them and
  restarts. `data/update/last.json` records what was installed and from where.
- **It only installs what a check showed.** `apply` refuses a version the updater has not
  fetched metadata for, and refuses when nothing newer exists.
- **No silent installs.** Auto-check runs every six hours by default and only fills the
  panel. Installation always requires a click. `update.autoCheck: false` disables even the
  check; `update.checkIntervalHours` changes the interval; `update.channel` is `stable` or
  `beta`.

If the release publishes `SHA256SUMS`, every file is verified against it. If it does not, the
log says so explicitly rather than implying a check that did not happen — the update then
rests on TLS and the syntax check, which is what every other console updater does.

Restart goes through `systemctl restart stellardns`, then `rc-service` on OpenRC, then falls
back to exiting and letting a supervisor restart the process. Config, users, logs and TLS
material are untouched.

## The encrypted client

`client/` is a local resolver for a single machine: a loopback listener that filters against
the same blocklists, answers from a small TTL cache, and forwards everything else over DoH
with DoT as a fallback. It is the same Node code on every platform.

- **DoH (RFC 8484)** sends the raw wire packet as `application/dns-message` over POST. No
  base64, no JSON transcoding — the packet the upstream sees is byte-identical to the stub's.
- **DoT (RFC 7858)** keeps one length-prefixed TLS connection per upstream and serialises
  queries through a queue.
- **Upstreams are tried in order**, so a filtered port 853 or a blocked DoH path degrades to
  the next transport instead of failing the lookup.
- **SERVFAIL is never cached.** A bad second at the upstream should not become minutes of
  failure locally.
- **The GUI is a loopback HTTP server plus one HTML file.** That is what lets one UI work in
  three shells: WebView2 on Windows, WebKit inside the AppImage, WKWebView on macOS. The API
  rejects any request whose `Host` is not loopback, so a DNS-rebinding page cannot drive it.
- **System DNS is reversible.** The previous value is written to config before the change, and
  `restore-dns` puts it back.

### Shells

| Platform | Shell | State |
|---|---|---|
| Linux | AppImage + `stellardns-client` on PATH | packaging script written, not built on this machine |
| Windows | WPF + WebView2 + MSI (`client/windows`) | installed from the MSI and launched on this machine |
| macOS | Swift package, SwiftUI + Metal (`client/macos`) | written, not compiled here |

The shells are intentionally thin — start the core, wait for `:5381`, render the shared page —
so the core can be replaced later without touching the UI or the policy.

### Windows installer

`client/windows/installer/wix` turns the published tree into a per-machine MSI: installs into
`%ProgramFiles%\StellarDNS`, adds a Start Menu shortcut, replaces older versions instead of
stacking, and supports silent install and uninstall. It installs no service and changes no DNS
setting — those stay deliberate actions in the app.

WiX is pinned to v5: v6 and later refuse to run until the Open Source Maintenance Fee EULA is
accepted, which is not something a build script should accept on your behalf.
The MSI is the only installer — no InstallShield project to maintain, and nothing commercial
is needed to rebuild it. It carries its own artwork and copy rather than the stock WiX chrome,
so it reads as StellarDNS and not as a generic setup wizard.

Closing the window no longer stops the resolver: it hides to a notification-area icon with
Open, Blocking on/paused, Restore system DNS and Exit, because a machine pointed at the client
would otherwise be left resolving against a dead port. Exit puts the saved resolvers back
before stopping the core, and the core now exits on its own if the window is killed. The app
icon is generated (`art/make-icon.ps1`) as a nine-size ICO and embedded in the executable, so
the window, taskbar, tray, shortcut and Programs and Features all carry it.

Two faults only appeared once the MSI was installed, not when the same files were run from the
build output. WebView2 keeps its browser profile under `%ProgramFiles%` by default and a
standard user cannot write there, so the runtime aborted the window with `E_ACCESSDENIED`; the
shell now uses `%LOCALAPPDATA%\StellarDNS\WebView2`. The published tree was also missing
`@leichtgewicht/ip-codec`, a dependency of `dns-packet` that always resolved out of the
repository's own `node_modules` in development, because Node walks up parent folders. Publish
now stages the full dependency tree, checks the entry points, and runs an encode/decode from a
copy outside the repository to prove the folder stands on its own.

## First run

The first launch after install asks one question: should this machine use StellarDNS for DNS?

Nothing changes until you click yes. The current resolvers are read and stored **before** the
change, so `restore-dns` or the Options toggle can put them back, and the prompt is remembered
the other way too — declining means it does not ask again.

On Windows the change needs administrator rights, so it goes through the UAC prompt; the client
then reads `netsh` back to confirm the setting took, instead of trusting an exit code. The
adapter is detected rather than assumed to be `Wi-Fi`. If you decline the elevation prompt, the
client says it was declined and leaves DNS alone.

## Rules from the LAN

The client can take its policy from the resolver you already run.

- **`GET /api/client/ping`** — unauthenticated, returns the service name, version and whether
  auth is required. A client has to be able to find the box before it owns a token; this
  reveals nothing that resolves a name or reads the policy.
- **`GET /api/client/rules`** — authenticated, returns the portable ruleset: categories with
  their targets and domains, blocklist URLs, the allowlist, and the block response mode.
- **The client picks.** Discovery sweeps the local /24 (or you paste an address), preview shows
  every category and list with counts and targets, and you tick what you want. The selection
  is written to `client.json` — categories, lists, allowlist — and the server is not consulted
  again until the next import.
- **Rewrites are opt-in, twice.** An import saves targets but leaves them inert, and the
  preview starts with every category unchecked and *Apply these rewrites on this machine* off.
  Only when you tick that — or run `stellardns-client rewrites on` — does a name in a category
  answer with the imported target, subdomains included; a category imported while disabled
  stays disabled either way. An import on its own cannot reroute a game.

The token never reaches the browser page: the client's loopback API performs the fetch, which
is also why no CORS grant or cross-origin exception was needed.

## Client options

Listen port, encrypted upstream presets (Cloudflare, Quad9, Mullvad, AdGuard over DoH or DoT),
block response (`NXDOMAIN` or `0.0.0.0`), cache entry ceiling, TTL floor and ceiling, system-DNS
management, the allowlist editor, and blocking on/off. Saving reports when a change needs a
restart instead of implying it took effect.

## The site

`docs/index.html` is the GitHub Pages landing page and `.github/workflows/pages.yml` publishes
it on push. Plain HTML, no Jekyll, no build step, no external fonts or scripts.

## Verified on this build

```
node --check server.js                    ok
console boots, /api/update/state served   ok
update check hits GitHub, reports version ok
apply refuses a version it has not checked ok
update endpoints reject a non-admin token  ok
client end-to-end against a mock DoH       ok
first-run DNS prompt (stubbed sysdns)     ok
import: discovery, rules, inert rewrite   25 checks
  pre-v25 server identified, not 404'd      ok
MSI administrative extract                36 payload files
MSI installed over a prior 25.0.0          installed copy is the rebuilt binary
installed client launches                  /api/state 200, resolver on 127.0.0.1:53
```

## Upgrading

- From v24.1: `Console → Updates`, or `sudo sh stellardns-install.sh` as before.
- No config changes are required. The `update` block is created on first check.
- Clients are optional; the server is unchanged if you never install one.

## Honest ceilings

The updater trusts GitHub and TLS. If `github.com` is compromised, or a maintainer account is,
the updater will install what that account publishes — the syntax check stops a broken build,
not a malicious one. Signing releases is the fix, and is not in this version.

The client filters names, not content. It cannot stop first-party ad delivery, a page that
loads ads from the same host it serves content from, or an app that bypasses the system
resolver with its own DoH. It also does nothing about IP-literal requests.

Windows is built, launched and packaged here. The Linux and macOS shells are unbuilt on this
machine; treat them as reviewed code, not as tested binaries.
