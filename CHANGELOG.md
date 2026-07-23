# StellarDNS — Changelog

Everything from the v5 alpha through **v19 (first stable release)**.

The alpha worked, but it had a set of bugs that only appeared once real config was
loaded and real traffic was flowing. Several of them shared one root cause: reading
configuration directly on the per-query hot path. That's harmless with an empty config
and fatal with a populated one, which is why each newly configured feature seemed to
break things again. v17–v19 swept that pattern out entirely.

---

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
