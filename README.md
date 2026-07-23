# StellarDNS

A fast, gaming-oriented DNS server with a web console.

Built for homelabs: LANCache rewrites with per-launcher toggles, blocklists, encrypted
upstreams, internal-zone forwarding, Active Directory support, and per-device policy —
in a single Node.js file with one dependency.

```
Cache hit latency   ~50 µs (p50)
Throughput          ~28,000 queries/sec per core, full ruleset loaded
Dependencies        1 (dns-packet)
Install             one script, Debian / Ubuntu / Alpine
```

---

## Features

**Game caching**
- LANCache-style **consistent static rewrites** — every domain in a category answers with
  your cache IP. No `lancache-dns` container required.
- One-click import of the [uklans/cache-domains](https://github.com/uklans/cache-domains)
  list (27 categories).
- Per-launcher on/off toggles. Turn Epic off, keep Steam on.
- Fully editable: add/rename/delete categories, move domains between them.

**Filtering**
- AdGuard, hosts, and plain-domain blocklist formats.
- Lists are validated before applying, with automatic rollback to the last good version if
  an update is malformed.
- CNAME-cloaking detection.
- Block responses: NXDOMAIN, null route, or a block page showing the reason.

**Privacy & transport**
- **DNS-over-TLS** (853) and **DNS-over-HTTPS** (8443) for clients — point Android's
  Private DNS at it.
- **Encrypted upstreams**: forward over DoH or DoT with connection reuse. Presets for
  Cloudflare, Quad9, Mullvad.
- 0x20 case randomization with echo verification, DNS Cookies, QNAME minimization.
- EDNS Client Subnet is **off by default**.

**Networks with structure**
- Internal zones that never leak to public upstreams.
- Conditional forwarding (longest-suffix match) — e.g. `ad.example.internal` → your DC.
- **Active Directory quick-add**: one step forwards the zone including `_msdcs` and SRV
  records, and routes private PTR lookups to the DC.
- Router fallback for unmatched internal names, with loop protection.
- Local A/AAAA/TXT/SRV/CNAME records, plus generators for apt-cacher-ng and Apple Content
  Caching discovery.

**Operations**
- Multi-core via `SO_REUSEPORT`, IPv4 + IPv6.
- Serve-stale during upstream outages, prefetching, query coalescing, per-upstream
  circuit breakers with adaptive RTT timeouts.
- **Failures are never cached** — only RFC 2308 negatives (NXDOMAIN/NODATA).
- Prometheus metrics, live analytics, memory reporting.
- Username/password auth (scrypt) plus an API token.
- Client ACLs, per-client rate limiting, per-VLAN policy.
- keepalived configs for a two-node HA pair.

---

## Install

```sh
git clone https://github.com/YOURNAME/stellardns.git
cd stellardns
sudo ./install.sh
```

Or non-interactively:

```sh
SD_ADMIN_PASS='choose-a-password' SD_CACHE_IP='10.0.0.5' sudo -E ./install.sh
```

Then open `http://<host>:5380` and sign in as `admin`. The first-run password is printed
to the service log:

```sh
journalctl -u stellardns | grep auth
```

**Requires** root, and Node.js ≥ 18 (installed automatically if missing). The installer
frees port 53 by disabling `systemd-resolved`'s stub listener.

### Single-file installer

For deploying without a checkout, the releases page carries a self-contained script with
the source embedded and checksum-verified:

```sh
sudo sh stellardns-install.sh
```

---

## Quick start

1. **Rewrites & launchers** → set your LANCache IP, or click *Import full uklans list*.
2. **Blocking** → paste a blocklist URL (e.g. a [hagezi](https://github.com/hagezi/dns-blocklists) list).
3. Point your router's DHCP DNS at this host.

Optional, if you run them:

- **Upstreams** → pick a DoH/DoT preset to encrypt queries leaving your network.
- **Local & internal zones** → add your AD domain and DC, or an internal TLD.

---

## Configuration

Everything lives in `/opt/stellardns/config.json`. Most of it is editable from the console;
the file is the source of truth. See [`config.example.json`](config.example.json).

Notable keys:

| Key | Default | Purpose |
|---|---|---|
| `workers` | `0` | `0` = one per core (max 8). Cache and budgets are **per worker**. |
| `cache.maxEntries` | `150000` | Per worker. |
| `cache.maxHeapMB` | auto | RAM guard per worker; auto-sized from the cgroup limit. |
| `upstreams[].protocol` | `udp` | `udp`, `tls` (DoT), or `https` (DoH). |
| `internalZones` | `[]` | TLDs that must never reach public upstreams. |
| `conditionalForwarders` | `[]` | Zone → internal resolver, longest suffix wins. |
| `internalFallback` | `"auto"` | Where unmatched internal names go; `auto` = default gateway. |
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

Connections are made **by IP**, with `hostname` used for SNI, certificate verification and
the Host header — so there's no bootstrap problem resolving your resolver.

---

## Endpoints

| Service | Port |
|---|---|
| DNS (UDP/TCP, IPv4+IPv6) | 53 |
| DNS-over-TLS | 853 |
| DNS-over-HTTPS | 8443 `/dns-query` |
| Web console & API | 5380 |
| Block page | 8053 |

### API

Authenticate with `x-api-token` (from `config.json`) or a session cookie.

```
GET  /api/stats            live counters, upstream health, memory, IPv6 state
GET  /api/metrics          Prometheus format
GET  /api/analytics        top domains / clients / blocked, disposition breakdown
GET  /api/log?n=200        recent queries
POST /api/category         create or update a rewrite category
POST /api/import-uklans    import the game CDN list
POST /api/settings         change resolver settings
POST /api/gen/ad-domain    configure an Active Directory domain
```

---

## Running it

```sh
systemctl status stellardns      # Debian/Ubuntu
rc-service stellardns status     # Alpine
journalctl -u stellardns -f
```

Or directly, for development:

```sh
npm install
node server.js
```

Deploying in an LXC or VM: see [`docs/lxc-deployment.md`](docs/lxc-deployment.md).
High availability: see [`ha/`](ha/).

---

## Design notes

A few decisions that aren't obvious:

**Rewrites bypass the cache entirely.** LANCache and launcher-toggle answers are resolved
in a triage step before the general cache, so they can't be evicted under load or compete
with organic traffic for cache slots.

**Failures are never cached.** Only NXDOMAIN and NODATA — actual facts about a name — are
stored. SERVFAIL and timeouts are facts about a *link*, and caching them means a two-second
blip leaves clients broken for minutes. Concurrent identical queries are coalesced instead,
and a per-upstream circuit breaker sheds a failing forwarder.

**Config never touches the query path.** Categories, local records, blocklists and internal
zones are compiled into indexes when they change, not scanned per query. Doing otherwise is
fine with an empty config and fatal with a populated one — see the
[changelog](CHANGELOG.md) for what that looked like in practice.

**Memory is bounded by heap, not entry count.** Entry counts are a poor proxy for RAM. Each
worker samples its own heap and sheds cache when over budget, and the budget is derived from
the **cgroup limit** — inside a container, `os.totalmem()` reports the host's RAM.

The [architecture document](docs/architecture.md) describes a kernel-bypass (AF_XDP +
io_uring) core for the same design. That is not implemented here; this is the portable
Node.js implementation of the policy and resilience layers.

---

## Contributing

Issues and pull requests welcome. Useful context when reporting a problem:

```sh
journalctl -u stellardns -n 100
curl -s -H "x-api-token: <token>" http://127.0.0.1:5380/api/stats
```

`/api/stats` includes memory and IPv6 listener state, which covers the two failure modes
that used to be silent.

---

## License

MIT — see [LICENSE](LICENSE).
