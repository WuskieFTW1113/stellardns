# StellarDNS — Changelog

## v25.0 — Northstar

**Updates without SSH.** The console gained an Updates view: check GitHub, read the release
body, install, restart, roll back. The trust boundary is narrow by construction — https only,
a host allowlist re-checked on every redirect, a 16 MB response cap, `node --check` on the
staged `server.js` before it replaces a running one, a backup of the replaced files in
`data/update/backup-<version>/`, and a one-click rollback driven by `data/update/last.json`.
`SHA256SUMS` is verified when the release publishes it, and the log says so explicitly when it
does not. Auto-check runs every six hours and only fills the panel: installation always needs
a click. New config block: `update: { channel, repo, autoCheck, checkIntervalHours }`.

**Encrypted client.** `client/` is a loopback resolver for one machine: the same blocklists
and suffix matching as the server, a TTL cache that never stores SERVFAIL, and DoH (RFC 8484,
raw wire format) with DoT (RFC 7858) as the fallback transport. The GUI is a loopback HTTP
server plus one HTML file, which is what lets WebView2, WebKit and WKWebView render the same
UI. Shells: WPF + WebView2 on Windows, an AppImage plus `stellardns-client` for Linux, SwiftUI
+ Metal on macOS. System DNS changes are recorded before they are applied and restored on
exit or with `restore-dns`. CLI: `run`, `status`, `test`, `block`, `unblock`, `refresh`,
`set-dns`, `restore-dns`, `install-service`.

**Rules from the LAN.** The server publishes a portable ruleset at `GET /api/client/rules`
(authenticated) and identifies itself at `GET /api/client/ping` (unauthenticated, version
only). The client discovers a server by sweeping the local /24, previews every category and
list, and imports only the pieces selected — category rewrites with their targets, blocklist
URLs and the allowlist — into its own `client.json`. Imported targets are inert until rewrites
are switched on, a category imported while disabled stays disabled, and the preview starts
with every category unchecked. A server older than v25 has no rules route and answers 401 to
any path it does not know, which used to look like an empty network in discovery and a bare
`HTTP 404` in the preview; discovery now identifies it from `/api/version` and says it needs
v25, and the preview names the version instead of blaming the token. The client also gained a full options surface: upstream presets over DoH/DoT, block
response, listen port, cache size, TTL bounds, system-DNS management and an allowlist editor,
with a clear restart signal when an option needs one.

**Nothing rewrites your traffic on its own.** Rewrites are the most intrusive feature in the
product and the easiest way to break someone's evening, so `rewritesEnabled` defaults to
`false` and `setSystemDns` does too. An import saves targets without applying them; the GUI
asks separately (*Apply these rewrites on this machine*, off by default); the CLI never turns
them on unless asked (`import --rewrites`, or `rewrites on|off|status`). Enabling is one
switch, reversible without re-importing.

**First run asks about DNS, once.** Installing the client does not repoint anything. The first
launch shows one question - use StellarDNS for this machine? - with the current resolver saved
before any change, so `restore-dns` and the Options toggle can put it back. On Windows the
change goes through the UAC prompt and is verified by reading `netsh` back, because a standard
user cannot set DNS and an exit code is not proof. Declining is remembered; the prompt does
not return.

**The loopback API refuses other websites.** The client's UI is a local HTTP server, and a page
that POSTs to `127.0.0.1:5381` supplies the loopback `Host` header itself — so the rebinding
check alone let any site the user visited toggle blocking or repoint the encrypted upstreams.
Every write now requires a same-origin (or absent) `Origin`, a `Sec-Fetch-Site` that is not
cross-site, and `application/json`, which a cross-site form or `no-cors` fetch cannot send
without a preflight this server never answers.

**Windows installer.** `client/windows/installer/wix` builds a per-machine MSI from the
published client: `%ProgramFiles%\StellarDNS`, Start Menu shortcut, major upgrade, silent
install/uninstall, about 1.1 MB with its own wizard art. The wizard keeps WiX's minimal flow
but uses StellarDNS artwork (`art/make-art.ps1`) and copy (`Strings.wxl`) instead of the stock
chrome. It installs no service and touches no DNS setting. WiX is pinned to v5 because v6+
will not run without accepting its maintenance-fee EULA. The MSI is the only installer; there
is no InstallShield project to keep in sync.

**Two installer-only bugs, found by installing it.** Neither reproduces from the build tree.
WebView2 puts its browser profile under `%ProgramFiles%` by default, which a standard user
cannot write, so the runtime refused to create the window with `E_ACCESSDENIED` and the shell
reported it as a missing runtime; the profile now lives in
`%LOCALAPPDATA%\StellarDNS\WebView2`. And the published tree was missing
`@leichtgewicht/ip-codec`, a dependency of `dns-packet` that always resolved from the
repository's own `node_modules` during development — Node walks up the tree, so the staged copy
looked complete while the installed one could not parse a packet. `publish.ps1` now stages the
whole dependency tree, asserts the required entry points exist, and proves self-containment by
running an encode/decode from a copy outside the repo. The same-version rebuild carries
`AllowSameVersionUpgrades`, so a fixed 25.0.0 replaces a broken 25.0.0 instead of offering
Repair.

**Tray icon, and a real app icon.** Closing the window now hides to the notification area
instead of stopping the resolver — with DNS pointed at the client, closing it would have left
the machine resolving against a port nothing answers on. The tray menu opens the window, pauses
or resumes blocking, restores the saved resolvers, and exits; exiting restores DNS first, then
stops the core. The icon (`art/make-icon.ps1`) is a generated nine-size ICO embedded in the
executable, so the window, taskbar, tray and Programs and Features all carry it rather than a
generic .NET glyph, and the MSI sets it as the Programs and Features icon too.

**GitHub Pages site.** `docs/index.html`, hand-written, no build step, published by
`.github/workflows/pages.yml`.

Upgrade: `Console → Updates` from v24.1, or re-run the installer. No config changes required.

## v24.1 — Spaceland

**Stealth that doesn't look like a filter.** The sinkhole answered every blocked name from
one address with a constant TTL of 60, and its port-80 stub replied to *any* Host header
with a perfectly shaped ad beacon — both are fingerprints. Blocked A answers now come from
this host's address on the client's own subnet, each name gets a stable TTL derived from
the name itself (300–3600 s, deterministic, so asking twice proves nothing), a blocked
AAAA with no `sinkholeIPv6` returns NODATA carrying a synthetic SOA the way a recursor
would, and Extended DNS Errors are suppressed on every block path in stealth mode — EDE
15/17 is a machine-readable "I filtered this".

**One answer per block.** A CNAME-cloaked tracker used to NXDOMAIN while an ordinary hit got
a sinkhole address, so the blocks that were hardest to explain were also the easiest to
detect. Both paths now share `blockAnswer()`, and the block-page address can no longer leak
into stealth mode as a fallback when interface discovery fails.

**The stub is not an oracle.** It answers only names that are actually on a blocklist and
returns `404` for everything else, instead of handing a valid ad-beacon response to any name
pointed at the resolver.

**Release packaging.** `SECURITY.md`, issue and PR templates, a CI job that runs the real
suites instead of a single boot check, and consolidated v24.1 release notes.

**Reporting.** `/api/stats` exposes `stealth: { mode, address, addresses[], stub80, fixed }`,
and the Block response panel shows the detected sinkhole address and stub state next to the
mode selector.

The `test/sinkhole.js` suite grows from 7 checks to 11: per-host gating, blocked-AAAA NODATA,
TTL variance across names, and TTL stability for one name.

## v24 — performance, diagnostics and console polish

**Faster upstream path.** Cache misses no longer create and destroy a UDP socket per
query. Long-lived sockets, one per address family, are shared by all in-flight queries
and replies are matched on (address, port, DNS id), removing four syscalls and two
allocations from every miss. Measured 5,195 q/s on a single worker over loopback with
40-way concurrency.

**Less garbage on the hot path.** With a full cache, every insert materialised an array
of *all* keys in order to evict 1% of them; eviction now walks the iterator. Blocklist and
allowlist matching no longer build a closure per query, and internal-zone matching uses a
pre-normalised list instead of calling `normZone()` per configured zone per query.

**New: `GET /api/resolve?name=…&type=…`.** Resolves through the exact path a client takes
— local records, zone forwarding, rewrites, blocklists, cache — and returns the rcode,
timing and answers. Surfaced in the console as a *Resolve a name* tool; diagnostic queries
bypass the query log so they do not skew analytics.

**New: DoH JSON form.** `/dns-query?name=example.com&type=A` returns the JSON shape used
by `dig`-style tooling; the RFC 8484 wire format remains the default.

**New telemetry.** `/api/stats` now reports `qps` (sampled once a second, summed across
cluster workers) and `hitRate`, and log entries carry the transport that produced them,
shown as a new column in the console.

**Console.** Area-and-grid QPS chart with a peak readout, a live q/s card, an active-nav
rail, visible focus rings, card hover feedback, reduced-motion support, and the Resolve
panel.

**Security.** The generated admin password is written to `data/.admin-password` (mode 600)
instead of printed to stdout, where journald kept it forever. The installer sets passwords
through the API using `node` and an environment variable: no shell interpolation into JSON
(a quote or backslash used to break it) and no secret on a command line visible in `ps`.

**The installer is now an updater.** Re-running it verifies the payload checksum, waits for
the listener to release before replacing files, keeps `config.json`, `data/`, users and TLS
material, saves `config.json.pre-<version>`, syntax-checks the new `server.js` before
restarting, and reports the console URL and API token at the end. `--check` verifies a
download without touching the system.

## v22 — compatibility sinkhole and console management

- Added configurable DNS sinkhole A/AAAA responses for blocked domains and a local HTTP stub response mode with JSON/HTML responses and CORS preflight handling. This is compatibility assistance, not a guarantee of undetectability; HTTPS interception is not enabled.
- Added timed pause/resume for blocklist enforcement. Pause expiry is persisted as a timestamp and resumes automatically after restart.
- Added client IP display-name mappings, configuration export/validated restore endpoints, a light/dark theme toggle, query-log filtering, and sinkhole controls.
- Added sinkhole and client-name configuration defaults.
- Preserved v21 defaults and existing blocklist/allowlist behavior.

Everything from the v5 alpha through **v20**.

The alpha worked, but it had a set of bugs that only appeared once real config was
loaded and real traffic was flowing. Several of them shared one root cause: reading
configuration directly on the per-query hot path. That's harmless with an empty config
and fatal with a populated one, which is why each newly configured feature seemed to
break things again. v17–v19 swept that pattern out entirely.

---

## v20 — internal zones, HA health checks

### Internal zones with a leading dot never matched

Entering a zone as `.internal` rather than `internal` — a natural way to type it, and how
several other DNS tools accept zone input — matched nothing, ever. `stellarad.internal` in
the same list worked, which made the bug look zone-specific rather than what it was.

The normalizer stripped only a *trailing* dot, so `.internal` stayed `.internal` and the
suffix check became `qname.endsWith('..internal')`, which cannot occur. The same incomplete
pattern existed in six places: internal zones, conditional-forwarder zones, local record
names, and the QNAME-minimization helper.

Fixed with a single `normZone()` used wherever a zone or domain config value is read,
stripping leading *and* trailing dots. Also applied when zones are saved, so an existing
`.internal` self-heals on the next edit.

### Forwarding loop guard was too broad

When a router forwards client queries to StellarDNS, every query arrives *sourced from the
router*. The internal-zone and PTR paths treated "the asker is one of my forwarders" as
"refuse immediately", so internal names failed for the whole network. Conditional-forwarder
zones kept working because that path only excluded the asker from its upstream list rather
than refusing outright — which is why a zone like `ad.example.internal` resolved while
`.internal` did not.

Both paths now do the precise thing: drop only the *asking* resolver from that query's
upstream list, and refuse only when nothing else remains to consult. Loop prevention is
unchanged — a query is never bounced back to its sender.

If your only internal fallback *is* the router, and the router forwards to StellarDNS,
nothing else remains to consult and internal names still cannot resolve. That is a topology
loop, not a bug; see **Internal zone topology** in the README.

### HA health checks could drop the VIP during a WAN outage

The keepalived health check queried a public name, and `dig` exits non-zero on timeout.
During an upstream outage the check failed on **every node at once**, so all instances
entered FAULT and the VIP disappeared — exactly when the resolvers were still perfectly able
to serve cache, LANCache rewrites and internal zones.

- Added `health.stellardns`: answered locally, never forwarded, never cached. `TXT` returns
  worker count, cache size and uptime.
- The health check now uses it, so it tests resolver liveness rather than internet
  reachability. Verified with dead upstreams: the health name answers in 8 ms while a public
  name times out.
- VRRP switched to **unicast peering**, avoiding the most common split-brain cause
  (switches or firewalls filtering multicast 224.0.0.18).
- Every failure mode is documented in `ha/keepalived.conf`, including the one a VIP cannot
  cover — both nodes down — and its mitigation (a second DHCP-supplied DNS server).

### Installer

`package.json` was not copied during an in-place upgrade, so `npm install` found nothing and
the failure was masked by `|| true`. Harmless while `node_modules` already existed, broken
the moment it did not. Now copied, and npm failures are surfaced instead of swallowed.

## v19 — CPU spikes on save, and per-query CPU

Found by CPU profiling rather than inspection.

- **Every config save made every worker re-parse the entire blocklist.** A save
  broadcast a reload; each worker then re-read the blocklist snapshot from disk. With a
  258k-entry list that's 85 ms of `JSON.parse` + Set build **per worker** — about
  **0.68 CPU-seconds per save on 8 workers**, for a change unrelated to blocklists.
  Blocklists are now re-parsed only when the blocklist config actually changes.
- **Reloads are debounced** (250 ms), so a burst of saves causes one reload.
- **`detectGateway()` used `execSync`**, spawning a subprocess, and ran on every worker
  on every reload — profiled at ~5% CPU. Now cached for 5 minutes.
- **File logging ran per query** (`JSON.stringify` + `Buffer.byteLength` + stream write
  on every lookup). Now batched: 500 lines or 500 ms.
- **The query log used `Array.shift()`** — O(n) — so once the ring filled, every query
  memmoved the whole 2000-entry array. Now a true O(1) circular buffer.
- **The heap sampler keyed off `cache.size`**, which sits on a multiple of 1024 when the
  cache is full, so `process.memoryUsage()` fired on every insert instead of every 1024th.

Measured after: 10 rapid rule saves with a 258k blocklist on 4 workers cost
**0.15 CPU-seconds total**, blocklist parsed once at startup.

## v18 — Hot-path allocation (spikes when adding records or blocklists)

Same root cause as v17, in three more places. All ran on **every query** and allocated:

- `matchLocal()` — two `Array.filter()` allocations plus a `toLowerCase()` per record.
- `rebindingExempt()` — `toLowerCase()` + string concat per local record and per internal
  zone.
- `suffixes()` — `split('.')` plus `slice().join()` per label, ~7 allocations per call,
  used by blocklist matching on every query.
- `rebindingAllow` — per-query array allocation and linear scan.

All now compile to Maps/Sets built once, with an allocation-free right-to-left label walk.
Verified at 28–29k QPS with categories, local records and a blocklist loaded together;
heap flat at 19 MB. Blocking semantics unchanged.

## v17 — LANCache category matching (CPU/memory spike)

`matchCategory()` ran `Object.entries(config.categories)` then a linear
`Array.includes()` scan over every category's domain list, for every suffix of the
queried name — and it was called **up to 3× per query**. With 26 categories that's
thousands of comparisons and a fresh array allocation per lookup. The GC couldn't keep
up: CPU spiked, heap climbed, the process died.

Categories are now compiled into a flat `domain → category` Map.

| | time | rate | heap |
|---|---|---|---|
| Old linear scan | 3,907 ms | 51,193/s | +1.9 MB |
| New indexed Map | **56 ms** | **3,602,354/s** | −1.1 MB |

**70× faster.** End to end with the real uklans list: 25,618 QPS on rewrite hits,
28,387 QPS on non-matching names — faster than before any categories existed.

## v16 — Analytics tab

`analytics` was missing from the view-title map, so the lookup threw inside the nav
click handler. The throw aborted the handler after swapping the visible section but
before setting the title or loading data — hence analytics panels under a stale
"Query log" heading, with empty tables. Added the entry, and navigation is now
defensive so a missing title can never break a view again.

## v15 — Memory leak (OOM)

RSS sat flat, then climbed sharply until the container OOM-killed DNS. Three causes:

- **`cache.maxEntries` defaulted to 2,000,000 — per worker.** With one worker per core
  that's up to 16M entries on an 8-core box. Now 150,000.
- **The snapshot was the spike.** `snapshotCache()` built a full array copy of the cache
  *and* one giant JSON string before writing — a multi-GB transient allocation. It now
  streams to disk and caps at 50k records.
- **`blockReasons` grew without bound.** It only evicted entries older than an hour, but
  ad/tracker domains use unique random subdomains, so a burst produced thousands of
  entries all newer than the cutoff and nothing was removed. Now a hard-capped LRU.

Added `cache.maxHeapMB`, a real RAM guard: each worker samples its heap and sheds 25% of
the cache when over budget. The budget sizes itself from the **cgroup limit** — important
in a container, where `os.totalmem()` reports the *host's* RAM. Memory is now reported in
`/api/stats`.

Verified: 400k cache inserts held at 122k entries with heap pinned to budget; 500k unique
blocked domains held `blockReasons` at exactly 2,000.

## v14 — Crash / config corruption

`saveConfig()` broadcast a reload to every worker; the reload path called
`registerSelfRecord()`, which called `saveConfig()` again — a save/reload storm. With one
worker per core, up to 8 processes called `fs.writeFileSync` on `config.json`
simultaneously. That call **isn't atomic**, so writes interleaved and corrupted the file:
zones, forwarders and rewrites vanished and the service crash-looped until systemd hit its
restart limit and gave up.

- Config writes are atomic (temp file + rename) and keep a `.bak`.
- Saves during a reload no longer re-broadcast, so the loop can't form.
- `registerSelfRecord()` runs once in the primary before workers fork.
- A corrupt config is **recovered from backup** instead of reverting to defaults; the bad
  copy is kept as `config.json.corrupt`.
- `uncaughtException` / `unhandledRejection` are logged, not fatal — verified with 2,400
  malformed packets: all workers survived and kept answering.
- systemd `StartLimitIntervalSec=0`, so a crash loop can never permanently disable DNS.

## v13 — Forwarding loops with the router / domain controller

If a machine StellarDNS forwards to also forwards *to* StellarDNS, internal-zone and
private-PTR queries bounced back and forth until timeout — floods of
`internal-router-fail:timeout` at ~2400 ms each, especially when something
reverse-resolved a whole subnet.

- A query arriving **from** one of our own forwarders is answered locally or NXDOMAIN'd
  immediately, never bounced back.
- Any forwarder equal to the querying client is dropped from that query's upstream list.
- `loopPeers` declares a peer's other addresses (e.g. the router's IPv6).
- `internalTimeoutMs` (700 ms): LAN-local forwarders fail fast instead of inheriting the
  2.4 s WAN timeout budget.
- `selfRecord`: auto-registers `<hostname>.<internalZone>` so the resolver's own name
  resolves.

Measured: 2400 ms SERVFAIL → 1–17 ms NXDOMAIN, legitimate forwarding unaffected.

## v12 — AAAA filtering *(optional)*

`filterAAAA` returns NODATA for public AAAA queries so clients use IPv4 — for when the
IPv6 path is a slow tunnel. Can be scoped to specific client CIDRs. Local records,
internal zones and LANCache `target6` are unaffected.

## v11 — apt-cacher-ng record generator

The generator produced an SRV pointing at a hostname with no A record, so the SRV
resolved but its target didn't. It now takes the proxy IP and emits both records.

## v10 — Encrypted upstreams (outbound DoT / DoH)

Upstream queries were plain UDP/53 — the hop across the public internet was unencrypted.
Upstreams now support `protocol: "https"` (DoH, RFC 8484) and `protocol: "tls"`
(DoT, RFC 7858).

- Connects by IP, using `hostname` for SNI, certificate verification and the Host header,
  which avoids the bootstrap problem.
- DoT holds one persistent multiplexed TLS connection per upstream; DoH uses a keep-alive
  agent — no handshake per query.
- SRTT timing, circuit breakers, failover, 0x20 verification and caching work identically
  across transports, so encrypted and plain upstreams can be mixed.
- One-click presets for Cloudflare / Quad9 / Mullvad in the Upstreams tab.

## v9 — IPv6

Three separate bugs:

1. **The IPv6 listener never started.** Shipped configs had `dns.host6: ""` and the code
   treated empty string as "disabled". Default is now `"::"`, and existing installs are
   **migrated automatically**.
2. **IPv6 upstreams were unreachable.** `upstreamQuery` hardcoded a `udp4` socket, so an
   IPv6 forwarder or domain controller could never be contacted. The socket family is now
   chosen per address.
3. **TCP, DoT, DoH and the web console were IPv4-only**, bound to `0.0.0.0`. They now bind
   `::` for dual-stack with automatic IPv4 fallback.

IPv6 listener state is reported in `/api/stats` and shown in the console sidebar, so a
failed bind is visible instead of silent.

## v8 — Active Directory

- **AD domain quick-add**: one step forwards the whole zone to the DC (covering `_msdcs`
  and the SRV records AD clients need), marks the TLD internal, and points private reverse
  lookups at the DC.
- **Private reverse DNS (PTR)**: RFC1918 / CGNAT / link-local / ULA lookups now go to
  internal resolvers and **never** to public upstreams. AD-joined machines depend on
  working PTR.
- **Boot-time resolver health probes**: each forwarder and the internal fallback is queried
  once at startup and logs `responding` or a loud warning, so an unreachable DC is obvious
  instead of a per-query mystery timeout.

## v7 — Internal zones reaching the router

Names in an internal zone with no conditional forwarder and no local record returned
NXDOMAIN. On a router-hosted setup (OPNsense/pfSense Unbound is authoritative for names
like `speedtest.internal`) that broke them. `internalFallback` now sends unmatched
internal names to the router — `"auto"` detects the default gateway. Internal names are
still never sent to public upstreams, and a loop guard refuses to forward to any address
bound to this host.

Resolution order: local records → conditional forwarder (longest suffix) → internal
fallback → NXDOMAIN + EDE.

## v6 — Remaining planned features

- **Happy Eyeballs assist**: querying A warms the sibling AAAA in the background (verified:
  sibling served in ~1 ms after pre-warming).
- **Analytics**: top domains, top blocked, top clients, disposition breakdown.
- **Record generators**: apt-cacher-ng `_apt_proxy._tcp` SRV and Apple Content Caching
  `_aaplcache._tcp` TXT.
- **DNSSEC strict mode**: `dnssec: "strict"` plus a domain list hard-fails a listed domain
  that returns unsigned over the trusted transport.

---

## Also added since the alpha

Username/password auth (scrypt) with sessions alongside the API token; fully editable and
interchangeable rewrites (add/rename/delete categories, move domains between them);
internal zones and conditional forwarding; DNS rebinding protection gated by an allowlist
so it can't break your own rewrites; Extended DNS Errors (RFC 8914); DNS Cookies (RFC
7873); DNSSEC AD-bit passthrough; jittered failover; multi-core workers via SO_REUSEPORT;
Prometheus metrics; per-device/per-VLAN policy; client ACLs and rate limiting; block pages;
keepalived HA configs; and a rebuilt web console.

---

## Upgrading

Run the installer. It detects an existing install and upgrades in place, preserving your
config, users, cache and rewrites. It also repairs damage from older versions: a corrupted
`config.json` is restored from backup, an oversized cache snapshot is removed, a stale
`maxEntries` is lowered, and `dns.host6: ""` is migrated to `"::"`.

```sh
sudo sh stellardns-install.sh
```

After a UI change, hard-refresh the browser (Ctrl-Shift-R / Cmd-Shift-R).

---

## v21 — blocklist allowlist / exceptions

Added a way to override a blocklist match for a specific domain, without editing or
removing the list itself. Motivated directly by real-world blocklists blocking Xbox/WSUS
delivery domains (`dl.delivery.mp.microsoft.com` and similar) alongside genuine telemetry —
previously the only fix was pulling the whole blocklist.

- **Allowlist panel** (Blocking tab): domains here are never blocked, regardless of which
  list matches them. Suffix-matched, so allowing a domain covers its subdomains.
- **One-click unblock**: every blocked row in the Query log and every entry in Analytics'
  "Top blocked" table now has an *unblock* button — no need to hunt down which list a
  domain came from or hand-edit config.
- New endpoints: `GET/POST /api/blocklist/allowlist` (full list), `POST
  /api/blocklist/allow` and `/api/blocklist/unallow` (single domain, used by the UI buttons).
- The allowlist is checked with the same allocation-free suffix walk used for blocklist
  matching itself, so it costs nothing extra on the query path — consistent with the
  hot-path rules in CONTRIBUTING.md.
- CNAME-cloaking detection automatically respects the allowlist too, since it already
  routes through the same `isBlocked()` check.

Verified end-to-end: a domain blocked by a live blocklist resolves normally once
allowlisted, an unrelated blocked domain is unaffected, and un-allowing restores blocking.
