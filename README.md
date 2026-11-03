# StellarDNS

![version](https://img.shields.io/badge/version-24.1.0-ff5c35) ![license](https://img.shields.io/badge/license-MIT-blue) ![node](https://img.shields.io/badge/node-%E2%89%A518-informational) ![CI](https://github.com/WuskieFTW1113/stellardns/actions/workflows/ci.yml/badge.svg)

A fast, gaming-oriented DNS resolver with a web console, built for homelabs.

LANCache rewrites with per-launcher toggles, blocklists with an allowlist, encrypted
upstreams, internal zones, Active Directory support and per-device policy — in a single
Node.js file with one dependency.

```
Cache hit (p95)     11.4 ms     end-to-end, real resolver, mixed workload
Cache miss (p95)    24.7 ms     with upstream jitter
Hit rate            86.2%
Throughput          5,195 q/s   one worker, 40-way concurrency
Dependencies        1           dns-packet
Install             one script  Debian / Ubuntu / Alpine
```

---

## What's new in v24.1 — Spaceland

- **Stealth that doesn't look like a filter.** Blocked names answer from this host's address
  *on the client's own subnet*, each with a TTL derived from the name (300–3600 s: stable per
  name, different across names), NODATA carrying a synthetic SOA when a blocked AAAA has no
  v6 sinkhole, and no Extended DNS Errors on any block path. The port-80 stub answers only
  names that are actually blocked and returns `404` to everything else, so it is no longer an
  oracle. See [Ad Blocking and the Sinkhole]([wiki/Ad-Blocking-and-Sinkhole](https://github.com/WuskieFTW1113/stellardns/wiki/Ad-Blocking-and-Sinkhole)).
- **One answer per outcome.** A CNAME-cloaked tracker used to NXDOMAIN while a plain ad hit
  got a sinkhole address, which made the best-hidden blocks the easiest to detect. Both now
  go through one function, and the block-page address can no longer leak into stealth mode.
- **A sinkhole suite that checks the disagreements** — TTL variance, per-host gating, NODATA
  shape and absence of block signalling, alongside the payload-shape checks.

Earlier in the v24 line: hedged upstreams, internal-name TTL clamping, request-shaped stub
payloads, and the installer-as-updater. See the [changelog](CHANGELOG.md) or
[release notes](RELEASE-NOTES-v24.1.md).

---

## Features

**Game caching**
- LANCache-style **consistent static rewrites** — every domain in a category answers with your
  cache IP. No `lancache-dns` container required.
- One-click import of the [uklans/cache-domains](https://github.com/uklans/cache-domains) list
  (27 categories).
- Per-launcher toggles. Turn Epic off, keep Steam on.
- Fully editable: add, rename and delete categories; move domains between them.

**Filtering**
- AdGuard, hosts and plain-domain blocklist formats.
- Lists are validated before applying, with automatic rollback to the last good version.
- CNAME-cloaking detection.
- An **allowlist** for exceptions, with one-click *unblock* on any blocked row in the log.
- Block responses: NXDOMAIN, null route, a block page, or sinkhole answers with a local HTTP
  stub. Sinkhole mode defeats simple "did DNS fail?" checks; it cannot defeat HTTPS
  interception, certificate pinning or script-level verification. No DNS-layer tool can.

**Privacy & transport**
- **DNS-over-TLS** (853) and **DNS-over-HTTPS** (8443) for clients — point Android's Private
  DNS at it.
- **Encrypted upstreams**: DoH or DoT with connection reuse, warmed at boot and every 60 s.
  Presets for Cloudflare, Quad9 and Mullvad.
- 0x20 case randomization with echo verification, DNS Cookies, QNAME minimization.
- EDNS Client Subnet is **off by default**.

**Networks with structure**
- Internal zones that never leak to public upstreams.
- Conditional forwarding (longest suffix wins) — e.g. `ad.example.internal` → your DC.
- **Active Directory quick-add**: one step forwards the zone including `_msdcs` and SRV
  records, and routes private PTR lookups to the DC.
- Router fallback for unmatched internal names, with loop protection.
- Local A/AAAA/TXT/SRV/CNAME records, plus generators for apt-cacher-ng and Apple Content
  Caching discovery.

**Operations**
- Built-in `health.stellardns` liveness name, answered locally and never forwarded, so HA
  health checks don't fail during a WAN outage.
- Multi-core via `SO_REUSEPORT`, IPv4 + IPv6.
- Serve-stale during upstream outages, prefetching, query coalescing, per-upstream circuit
  breakers with adaptive RTT timeouts.
- Prometheus metrics, live analytics, memory reporting, transport-labelled query log.
- Username/password auth (scrypt) plus an API token.
- Client ACLs, per-client rate limiting, per-VLAN policy.
- keepalived configs for a two-node HA pair.

---

## Install

### Single-file installer *(recommended)*

Self-contained: source embedded, checksum-verified, no checkout required.

```sh
sudo sh stellardns-install.sh
```

Verify a download without installing anything, or see what's inside:

```sh
sh stellardns-install.sh --check      # payload checksum
sh stellardns-install.sh --version    # version + build stamp
```

**Re-running it upgrades an existing install in place**: config, users, cache and TLS material
are preserved, `config.json.pre-<version>` is kept as a rollback, and the new `server.js` is
syntax-checked before the service restarts.

### From source

```sh
git clone https://github.com/WuskieFTW1113/stellardns.git
cd stellardns
sudo ./install.sh
```

Or non-interactively:

```sh
SD_ADMIN_PASS='choose-a-password' SD_CACHE_IP='10.0.0.5' sudo -E ./install.sh
```

`SD_DIR` overrides the install prefix (default `/opt/stellardns`); the systemd unit and OpenRC
script are generated from it, so a non-default prefix works without editing anything.

**Requires** root and Node.js ≥ 18 (installed automatically if missing). The installer frees
port 53 by disabling `systemd-resolved`'s stub listener.

### First sign-in

Open `http://<host>:5380` and sign in as `admin`. The password is not printed to the journal —
it is written to `data/.admin-password` (mode 600) on first run, and the installer prints it
once. Set your own in the console under **Access & users**, or with `SD_ADMIN_PASS`.

Confirm the running build:

```sh
curl -s http://127.0.0.1:5380/api/version
```

---

## Quick start

1. **Rewrites & launchers** → set your LANCache IP, or click *Import full uklans list*.
2. **Blocking** → paste a blocklist URL (e.g. a [hagezi](https://github.com/hagezi/dns-blocklists) list).
3. Point your router's DHCP DNS at this host.

Optional, if you run them:

- **Upstreams** → pick a DoH/DoT preset to encrypt queries leaving your network.
- **Local & internal zones** → add your AD domain and DC, or an internal TLD.

### Internal zone topology

Point clients at **StellarDNS directly**, not at the router which then forwards here.

```
clients -> StellarDNS -> router (for DHCP-registered .internal names)   correct
clients -> router -> StellarDNS -> router                               circular
```

In the circular form every query reaches StellarDNS sourced from the router, so the only
resolver it could ask for an unmatched internal name is the one that just asked it. The loop
guard correctly refuses rather than bouncing the query back, and internal names fail.

Alternatively, make StellarDNS **authoritative** for the zone: add the records under Local
records and remove the internal fallback. That removes the round trip, at the cost of DHCP
lease auto-registration — the router registers leases into DNS; StellarDNS does not. Static and
reserved hosts fit well; dynamic clients do not.

---

## How a query is resolved

A query is answered by the first of these that applies, and never reaches the network unless
all of them miss:

1. **Local records** — exact name/type, including the generated `health.stellardns`.
2. **Rewrite category** — LANCache and launcher toggles, answered before the cache so they
   cannot be evicted under load.
3. **Blocklist, allowlist, rebinding policy** — allocation-free suffix walk, CNAME-chain aware.
4. **Cache** — including RFC 2308 negatives. Failures are never cached.
5. **Upstreams** — internal zones go to their forwarder; public names are hedged across
   forwarders, first usable answer wins.

Internal and private names never leave the network, are never served stale, and are
TTL-clamped on the wire.

---

## Configuration

Everything lives in `/opt/stellardns/config.json`. Most of it is editable from the console; the
file is the source of truth. See [`config.example.json`](config.example.json).

| Key | Default | Purpose |
|---|---|---|
| `workers` | `0` | `0` = one per core (max 8). Cache and budgets are **per worker**. |
| `cache.maxEntries` | `150000` | Per worker. |
| `cache.maxHeapMB` | auto | RAM guard per worker; auto-sized from the cgroup limit. |
| `hedge` | `true` | Start the next forwarder when the current one is slow. |
| `hedgeDelayMs` | `60` | Silence before hedging. `race: true` = hedge at 0 ms. |
| `internalTtlCap` | `30` | Max TTL, in seconds, for internal/private answers. |
| `internalServeStale` | `false` | Never serve stale data for internal names. |
| `upstreams[].protocol` | `udp` | `udp`, `tls` (DoT), or `https` (DoH). |
| `internalZones` | `[]` | TLDs that must never reach public upstreams. |
| `conditionalForwarders` | `[]` | Zone → internal resolver, longest suffix wins. |
| `internalFallback` | `"auto"` | Where unmatched internal names go; `auto` = default gateway. |
| `sinkholeIP` | `""` | Block address. Empty = auto-discover this host's LAN address. |
| `blockedResponse` | `"nxdomain"` | `nxdomain`, `zeroip`, `sinkhole`, or `blockpage`. |
| `filterAAAA` | `false` | Return NODATA for public AAAA (use when IPv6 is a slow tunnel). |
| `dnssec` | `"passthrough"` | `passthrough`, `strict`, or `off`. |
| `ecs` | `false` | EDNS Client Subnet — off for privacy. |

### Encrypted upstream example

```json
{
  "upstreams": [
    { "name": "cloudflare-doh", "protocol": "https", "address": "1.1.1.1",
      "port": 443, "hostname": "cloudflare-dns.com", "path": "/dns-query" },
    { "name": "quad9-dot", "protocol": "tls", "address": "9.9.9.9",
      "port": 853, "hostname": "dns.quad9.net" }
  ]
}
```

Connections are made **by IP**, with `hostname` used for SNI, certificate verification and the
Host header — so there's no bootstrap problem resolving your own resolver.

---

## Endpoints

| Service | Port |
|---|---|
| DNS (UDP/TCP, IPv4 + IPv6) | 53 |
| DNS-over-TLS | 853 |
| DNS-over-HTTPS | 8443 `/dns-query` |
| Web console & API | 5380 |
| Block page | 8053 |
| Sinkhole HTTP stub | 80 (only while sinkhole mode is active) |

### API

Authenticate with `x-api-token` (from `config.json`) or a session cookie.

```
GET  /api/stats             counters, upstream health, memory, IPv6 state, qps, hitRate
GET  /api/version           version, pid and build stamp
GET  /api/metrics           Prometheus format
GET  /api/analytics         top domains / clients / blocked, disposition breakdown
GET  /api/log?n=200         recent queries, with transport
GET  /api/resolve           resolve a name through the full path, with timing
GET  /api/backup            export configuration
POST /api/backup/restore    validated restore
POST /api/category          create or update a rewrite category
POST /api/import-uklans     import the game CDN list
POST /api/settings          change resolver settings
POST /api/blocklist/allow   allow a domain through every blocklist
```

`/api/resolve` is the one to reach for when a name misbehaves — it takes the same path a client
does and tells you which stage answered:

```sh
curl -s -H "x-api-token: $TOKEN" \
  'http://127.0.0.1:5380/api/resolve?name=store.steampowered.com&type=A'
```

DoH accepts both forms. A `name` parameter selects JSON:

```sh
curl -s 'https://<host>:8443/dns-query?name=example.com&type=A'
```

The RFC 8484 wire format (`GET ?dns=` or `POST`) remains the default; `?name=` returns the JSON
shape `dig`-style tooling expects, with no `Accept` header needed.

---

## Operations

```sh
systemctl status stellardns      # Debian / Ubuntu
rc-service stellardns status     # Alpine
journalctl -u stellardns -f
```

Or directly, for development:

```sh
npm install
node server.js
```

Deploying in an LXC or VM: see [`docs/lxc-deployment.md`](docs/lxc-deployment.md).
High availability: see [`ha/`](ha/) — a keepalived VIP pair with every failure mode documented.

The VIP is an address that *moves* to whichever node is healthy, not a proxy. Failover is ~3 s
for node loss and ~4 s for a dead resolver process. The one case a VIP cannot cover is both
nodes being down, so hand out a second DNS server via DHCP:
`DNS servers: <VIP>, <node A physical IP>`.

---

## Testing

Every check runs as an unprivileged user — no root, no port 53, no external network. Each suite
boots the real resolver on a high port against a fake upstream, so it tests the shipped code
rather than a mock.

```sh
node test/smoke.js       # cache, rewrites, local records, socket pool, API endpoints
node test/fastpath.js    # hedging (slow-but-alive upstream) and duplicate-RR removal
node test/sinkhole.js    # address discovery, request-shaped payloads, no fingerprint
node test/simulate.js    # 1,202-query mixed workload: answers + latency distribution
```

The numbers at the top of this file come from `test/simulate.js`. Run it yourself rather than
trusting them.

---

## Design notes

A few decisions that aren't obvious.

**Rewrites bypass the cache entirely.** LANCache and launcher answers are resolved in a triage
step before the general cache, so they cannot be evicted under load or compete with organic
traffic for cache slots.

**Failures are never cached.** Only NXDOMAIN and NODATA — facts about a name — are stored.
SERVFAIL and timeouts are facts about a *link*, and caching them means a two-second blip leaves
clients broken for minutes. Identical in-flight queries are coalesced instead, and a
per-upstream circuit breaker sheds a failing forwarder.

**Slow is not the same as dead.** Failover used to await each forwarder in turn, so one that was
merely slow added its full latency to every query plus a jittered retry. Now the next forwarder
starts after `hedgeDelayMs` of silence and the first usable answer wins — the query costs the
fastest healthy path, not the sum of the unhealthy ones.

**Internal names are clamped because the client caches too.** A resolver can flush its own cache
all day; a client that received a one-hour TTL for its own hostname keeps that address for an
hour, and an mDNS client that sees its name already taken renames itself with a numeric suffix.
Clamping to 30 s on the wire is the only fix that reaches the copy you don't control. Duplicate
resource records are dropped for the same reason — mDNS reads them as a conflict.

**Config never touches the query path.** Categories, local records, blocklists and internal
zones are compiled into indexes when they change, not scanned per query. Doing otherwise is fine
with an empty config and fatal with a populated one — the [changelog](CHANGELOG.md) shows what
that looked like in practice.

**Memory is bounded by heap, not entry count.** Entry counts are a poor proxy for RAM. Each
worker samples its own heap and sheds cache when over budget, and the budget is derived from the
**cgroup limit** — inside a container, `os.totalmem()` reports the host's RAM.

The [architecture document](docs/architecture.md) describes a kernel-bypass (AF_XDP + io_uring)
core for the same design. That is not implemented here; this is the portable Node.js
implementation of the policy and resilience layers.

---

## Troubleshooting

**Port 53 is already in use.** Usually `systemd-resolved`. The installer disables its stub
listener; to do it by hand: `systemctl disable --now systemd-resolved`. On a host using
NetworkManager, also point `/etc/resolv.conf` at this resolver.

**The console looks unchanged after an upgrade.** The page is served `no-cache`, but a hard
refresh (Ctrl-Shift-R / Cmd-Shift-R) rules out a cached stylesheet or script.

**A device still has a numeric suffix on its name.** This release stops it recurring. The
suffix already stored on the device (or in the router's lease table) has to be cleared once.

**Websites still detect the block.** Sinkhole mode removes the obvious signal — a failed DNS
lookup — and makes the stub answer look like the media that was requested. Detection that runs
entirely in the page, uses first-party ad delivery, or verifies over HTTPS is outside what DNS
can influence. The README says so deliberately: the honest ceiling is *harder to detect*, not
*undetectable*.

**Internal names return NXDOMAIN.** Almost always the circular topology above, or an internal
zone with no forwarder and no fallback. `GET /api/resolve` shows which stage answered and
whether the name was treated as internal.

**The service will not start.** `journalctl -u stellardns -n 40`. A corrupt config is recovered
from `config.json.bak` automatically and the bad copy is kept as `config.json.corrupt`.

---

## Contributing

Issues and pull requests welcome. Useful context when reporting a problem:

```sh
journalctl -u stellardns -n 100
curl -s -H "x-api-token: <token>" http://127.0.0.1:5380/api/stats
curl -s -H "x-api-token: <token>" 'http://127.0.0.1:5380/api/resolve?name=<name>&type=A'
```

Hot-path changes should come with a number from `test/simulate.js` — see
[CONTRIBUTING.md](CONTRIBUTING.md) for the rules that keep the per-query path allocation-free.
Security issues should go through [SECURITY.md](SECURITY.md), not a public issue.

## License

MIT — see [LICENSE](LICENSE).
