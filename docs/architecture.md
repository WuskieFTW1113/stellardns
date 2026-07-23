# Fastest DNS Server on the Planet — NVMe-Accelerated Architecture

## The core truth you need to design around

A DNS answer is 12–512 bytes. The entire "work" of answering a cached query is a hash lookup — nanoseconds. Every commodity resolver (Unbound, dnsmasq, BIND, Technitium, CoreDNS) is actually bottlenecked by:

1. **Kernel network stack overhead** (syscalls, socket buffer copies, context switches) — this is 80–95% of your latency budget, not app logic.
2. **Memory allocation / GC** (Go and C# resolvers pay for this — CoreDNS and Technitium both do allocations per-query).
3. **Lock contention** on the cache under high QPS.

NVMe read latency (even DC-class, ~10–20µs random read) is *slower* than a RAM cache hit (~100ns) by 100x. So the design principle is:

> **The hot path never touches NVMe. NVMe does everything that makes the hot path better without ever being in it.**

That's how you get free performance out of the drives without risking network throughput.

---

## Layer 1 — Network fast path (this is where 90% of your speed comes from)

Skip the kernel UDP stack entirely using **AF_XDP** (or DPDK if you want to go further, but AF_XDP is the better ROI — native since kernel 4.18, no out-of-tree driver headaches on your R630/R640 NICs if they support it, e.g. Intel X710/X520).

- Zero-copy AF_XDP socket bound directly to the NIC queue → packets land in a shared user-space ring buffer, bypassing `sk_buff` allocation and the normal socket path.
- Pin one NIC RX/TX queue pair per worker core (RSS + `ethtool -L`), `isolcpus`/`nohz_full` those cores so the scheduler never preempts them.
- Disable C-states and set `intel_idle.max_cstate=0`, `processor.max_cstate=1` on the DNS box — C-state exit latency alone can dwarf your query processing time.
- This alone typically takes a resolver from ~150µs (Unbound stock) to single-digit microseconds for a cache hit.

**Reference implementations to study/fork:** Cloudflare's `dnsdist`-style XDP prototypes, NLnet Labs' `getdns` isn't it, but **Knot Resolver** has an XDP mode built in (`kres` supports AF_XDP natively since Knot Resolver 5.x) — this is your fastest path to "already fast, in production, not hand-rolled Rust."

---

## Layer 1.5 — Request triage: LANCache & launcher-toggle short-circuit (runs *before* the general cache, not inside it)

This is the piece that changes with your latest requirement: a LANCache-bound query should never enter the general answer pipeline at all — no RAM cache lookup, no cache insert, no chance of ever falling through to upstream recursion. It hits the policy table and is done.

Order of operations per query, right after AF_XDP hands you the parsed qname:

1. **Triage lookup** — check the qname against the mmap'd perfect-hash policy table from Layer 3c (this is the same table used for launcher toggles and blocklists, unified). This table is small (a few hundred LANCache domains + your launcher categories + however many blocklist entries), so this check is essentially free — a single hash + compare, done before anything else runs.
2. **Three possible outcomes, each a hard branch:**
   - **LANCache match, category enabled** → build the static rewrite response (A/AAAA → your cache server IP) and send it immediately. **Full stop — do not touch the RAM cache, do not recurse, do not log to the async query logger's hot-path structures beyond a fire-and-forget counter increment.** The client's actual download traffic goes straight to the cache box for the whole session; DNS's only job was this one deterministic answer, and it should never be evicted, re-resolved, or subject to any cache policy — it's a static rule, not a cached fact.
   - **Launcher category disabled (toggled off)** → return NXDOMAIN (or a configurable blackhole IP, your call) immediately, same short-circuit, same reason: this shouldn't pollute or wait on the general cache either.
   - **No match in the policy table** → *only now* does the query proceed into Layer 2 (RAM answer cache → upstream recursion if it's a miss).

Why this matters beyond "it's tidy": the general RAM cache has eviction pressure, lock contention under load, and TTL bookkeeping. LANCache/launcher rules are static, config-driven, and should never compete with organic traffic for a cache slot or be at the mercy of an LRU eviction right when someone's mid-download. Keeping them on a completely separate, tiny, read-mostly table guarantees that behavior regardless of how hot the general cache gets.

---

## Layer 2 — The actual cache: 100% RAM, minimum 8GB, cache-line aware

- Open-addressing hash table (Robin Hood or Swiss-table style), keyed on qname+qtype, RRset stored inline to avoid pointer chasing.
- Pre-serialize the DNS wire-format answer at insert time so a cache hit is `memcpy` + send, not re-encode.
- **Reserve a hard 8GB floor** for this table at startup — don't let it grow-on-demand from a small default. Pre-allocate with `mmap(MAP_HUGETLB)` using 1GB hugepages if your kernel/BIOS has them configured (check `cat /proc/meminfo | grep Huge`), or 2MB hugepages otherwise. This isn't about needing 8GB of *data* — your actual working set (300+ games plus household traffic) is a few hundred MB — it's about eliminating TLB misses and page-fault jitter under load by giving the table a large, stable, hugepage-backed footprint instead of letting it grow into 4KB pages incrementally. Treat the 8GB as a floor, make the ceiling configurable (16/32GB) if you want more headroom for a bigger household/QPS load later.
- There is no scenario where you need NVMe for the *primary* cache — see Layer 1.5 above for why LANCache traffic doesn't even reach this layer, and see Layer 3a/3c for what the NVMe is actually for. Anyone telling you to "cache to NVMe for speed" has the layers backwards.

---

## Layer 3 — Where the NVMe actually earns its keep (all async, all off the hot path)

This is the "abuse the DC U.2 drives" part, done correctly:

### 3a. Instant warm-restart via persistent snapshot / WAL
Cold-cache after a reboot is the only place raw disk speed genuinely matters to user-perceived DNS speed. Periodically (or on graceful shutdown) `mmap` the entire cache table and `msync` it to the NVMe. On boot, `mmap` it back — with DC-class U.2 sequential reads north of 3GB/s, a multi-GB cache table rehydrates in low milliseconds. Full cache, zero cold-start penalty, zero impact on live query path.

### 3b. Async full query logging via io_uring
Log *every* query/response for stats, security, and blocklist tuning — without it ever blocking a response. Use `io_uring` in the logging thread only: batch log entries, submit with `IORING_SETUP_SQPOLL` so the kernel polls the submission queue instead of you doing a syscall per write. This gets you Pi-hole/AdGuard-style full query history at effectively zero cost to answer latency, something most "fast" resolvers skip because synchronous logging kills their numbers.

### 3c. Blocklist / LANCache rewrite table as a memory-mapped perfect hash
Big blocklists (OISD, AdGuard's own lists, hagezi) can be tens of millions of entries. Don't load them into a mutable hash map at startup (slow reload, GC pressure). Instead:
- Build a **minimal perfect hash function** (MPHF) offline over the domain set (tools: `cmph`, or Rust's `boomphf`/`ptr_hash`).
- Store the resulting table + a small metadata array (blocked/launcher-category/rewrite-target) as a flat file, `mmap`'d straight off the NVMe.
- Reload = swap the mmap pointer atomically. Tens of millions of rules reload in milliseconds with zero rebuild cost, and pages get pulled into page cache from NVMe on first touch at ~10-20µs each — a rounding error, and only paid once per boot.

This is also exactly the mechanism for your LANCache domain rewrites and per-launcher toggles from before: each entry carries a category ID (Steam / Epic / Battle.net / etc.), and toggling a launcher off is just a metadata bit flip, not a structural change to the table.

### 3d. L2 cache overflow tier (optional, marginal value)
If you ever want a cache far bigger than RAM (enterprise scale, not your household), LRU-evict cold entries to an mmap'd region on the NVMe instead of dropping them. For your actual use case this is over-engineering — mention it only because DC U.2 random-read IOPS make it *viable* at ~10-20µs, unlike doing this on SATA SSD or spinning disk, which would not be viable at all.

---

## Layer 4 — Isolation, so storage never steals network cycles

This is the part that satisfies "without knocking down network speeds":

- **NUMA-pin everything.** Confirm which NUMA node your NIC and your U.2 slot are electrically attached to (`lspci -vvv`, check `numa_node` under `/sys/class/net/<if>/device/`). Run network worker threads and the AF_XDP rings on cores local to the NIC's NUMA node. Run the io_uring logging thread and mmap page-fault handling on cores local to the NVMe's NUMA node if they differ — cross-NUMA memory access is a bigger threat to your P99 than the NVMe itself.
- **Separate cores, separate purposes.** Network RX/TX + cache lookup gets its own isolated cores (`isolcpus`, `nohz_full`, IRQ affinity via `irqbalance` disabled + manual `smp_affinity`). Logging/snapshot/reload threads run on *other* cores entirely, so a slow NVMe write (rare, but tail latencies exist even on DC drives) can never preempt a query thread — there's no shared runqueue for it to contend on.
- **io_uring polling mode for storage, not the network path.** Keep network on AF_XDP, keep storage on io_uring — don't mix the two abstractions on the same thread.

---

## Software base recommendation

Don't hand-roll this from zero — extend something that's already fast and already has the primitives:

| Option | Verdict |
|---|---|
| **Knot Resolver (kres)** | **Recommended base.** C, modular, native AF_XDP support, Lua policy layer for custom rewrite/blocklist logic, mmap-friendly RPZ zones. Closest to this design out of the box. |
| Unbound | Fast, mature, but no native XDP — you'd be patching kernel-bypass in yourself. |
| PowerDNS Recursor + dnsdist | dnsdist in front for XDP-style load distribution is solid, but two moving parts to tune instead of one. |
| Custom Rust (hickory-dns + io_uring + AF_XDP via `xsk-rs`) | Ultimate ceiling, ultimate effort. Worth it only if Knot's Lua layer becomes a real bottleneck for your launcher-toggle logic — unlikely at household/homelab QPS. |
| CoreDNS / Technitium | Not candidates for this build — GC-managed runtimes (Go/C#) put a floor under your tail latency that no amount of NVMe cleverness fixes. Keep Technitium as your general-purpose/admin-friendly DNS if you want, but it's a different tier than this. |

**My call: Knot Resolver as the base**, with a Lua (or C module, if you want to go further) policy layer implementing the mmap'd perfect-hash lookup for blocklists + LANCache rewrites + launcher toggles, io_uring logging thread bolted on separately, cache snapshot/restore to NVMe on startup/shutdown.

---

## Realistic latency targets

- Cache hit, AF_XDP + RAM table: **1–5µs**
- Cache miss requiring upstream recursion: dominated by the network RTT to upstream, not your box (nothing to optimize here beyond not being the bottleneck)
- Cold boot to fully warm cache: **milliseconds** (NVMe snapshot restore) instead of minutes/hours of organic re-warming
- Blocklist reload with 20M+ entries: **single-digit milliseconds**, atomic swap, zero query disruption

---

## Where last time's requirements slot in

Everything from the gaming-DNS plan (LANCache rewrite-to-IP without the lancache-dns container, per-launcher on/off toggles, AdGuard Home blocklist format ingestion) becomes a **thin policy layer on top of this core** — specifically the mmap'd perfect-hash table in Layer 3c. None of it touches the hot path differently than a plain blocklist lookup would, so building the fast core first is the right order of operations.

## Feature parity — what other resolvers do that you should steal, and the issues each one brings

Technitium is the most feature-complete open-source resolver right now, so it's a good checklist. It supports <cite index="10-1">serve-stale, prefetching and auto-prefetching, persistent disk-backed cache across restarts, DNSSEC validation with RSA/ECDSA/EdDSA, QNAME minimization, and QNAME case randomization (0x20 encoding)</cite>, plus <cite index="10-1">EDNS Client Subnet support, extended DNS errors, and DNS rebinding protection as an add-on app</cite>. Here's what's worth pulling in, and where each one has a sharp edge:

### Worth building in
- **Serve-stale (RFC 8767).** Keep a record past its TTL and serve it if the upstream/authoritative chain is unreachable or broken, instead of SERVFAIL-ing the client. This is your resilience layer against upstream outages — Cloudflare's own writeup on the .de TLD DNSSEC outage credits serve-stale with keeping their <cite index="15-1">NOERROR rate stable while records with broken signatures would otherwise have failed</cite>. Pairs naturally with your Layer 3a NVMe snapshot — same "don't lose good state" philosophy.
- **Prefetching / auto-prefetch.** Proactively re-resolve hot entries before they expire so a popular domain never actually produces a cache miss during peak use. Cheap to add once you have the RAM cache structure; big perceived-speed win.
- **QNAME minimization (RFC 7816/9156) + 0x20 case randomization.** Both are privacy/anti-spoofing wins that cost almost nothing — minimization means you only send upstream the labels needed for that hop instead of the full qname, and case randomization makes cache-poisoning off-path attacks dramatically harder. Add both to Layer 2's recursion path.
- **DNS Cookies (RFC 7873).** Lightweight anti-spoofing for UDP that avoids forcing a TCP fallback (which itself can be a resource-exhaustion vector). Cheap, standard, no real downside.
- **Extended DNS Errors (RFC 8914).** Lets you tell a client *why* something failed (blocked vs. filtered vs. upstream failure) instead of a bare SERVFAIL/NXDOMAIN. Directly useful for your launcher-toggle feature — a disabled launcher should surface as "blocked by policy," not an ambiguous failure, which makes debugging your own rewrite table trivial.
- **CNAME cloaking detection.** Some ad/tracking domains hide behind a CNAME that resolves to a blocked domain, sneaking past naive blocklist matching. Worth checking the CNAME chain against your policy table, not just the original qname.
- **Health-checked forwarders with failover.** If you're conditionally forwarding to multiple upstreams (Cloudflare, Quad9, your own recursion), actively health-check them and fail over rather than discovering a dead upstream via a wave of client SERVFAILs.

### Worth building in, but with a real caveat
- **DNSSEC validation.** Protects against cache poisoning and off-path spoofing, but a misconfigured or broken upstream zone turns into a hard SERVFAIL for every client, all at once — see the .de TLD incident above, and note Quad9 just moved to strict validation on *all* endpoints as of June 2026, closing out their last non-validating resolver. <cite index="11-1">Quad9 now returns SERVFAIL for DNSSEC failures across every service address, whether from misconfiguration or actual tampering</cite> — meaning there's no longer a "fail open" public option to fall back to for testing. **Do validate, but pair it with serve-stale so a DNSSEC break degrades to stale-but-working instead of a full outage**, and keep a non-validating debug mode toggle for troubleshooting.
- **EDNS Client Subnet (ECS).** Improves CDN routing accuracy (game patch CDNs picking the geographically closest edge) but leaks a slice of the client's subnet to every upstream you forward to — a real privacy tradeoff for a household resolver. Recommend: off by default, with a manual override you can flip on per-forwarder if you notice a specific CDN routing you somewhere bad.
- **DNS rebinding protection.** Blocks external names that resolve to private/internal IPs — the standard defense against a malicious webpage using your own DNS to pivot into your LAN. **This directly conflicts with your own architecture**: your LANCache rewrites, any internal service domains, and OPNsense/AD-integrated lookups are *supposed* to resolve to private IPs. You need an explicit allowlist keyed off your policy table (same mmap'd structure) so rebinding protection only fires for domains *not* in your rewrite/internal zone list — otherwise it'll actively break the thing you just built.
- **Response Rate Limiting (RRL).** Protects an authoritative server from being abused as a DNS amplification reflector. Matters much more for Libereon's public-facing PoPs than for this household resolver — but if you ever run this same codebase authoritative-side too, be aware RRL can false-positive against legitimate high-volume resolvers/CDNs sharing a NAT'd IP, so it needs a carefully tuned threshold, not a naive per-IP counter.

### The issue that can quietly undo everything else: DoH bypass
This is the one most homelab DNS setups miss. Modern browsers (Firefox, and Chrome under some configs) ship with **built-in DNS-over-HTTPS that defaults to a public resolver** (Cloudflare/NextDNS), completely bypassing whatever you've configured at the OS/router level — including your LANCache rewrites and blocklists, silently, per-app. Two mitigations, use both:
1. **Firewall-level block of known public DoH endpoints** on port 443 for the well-known resolver IPs, forcing fallback to your local resolver.
2. **Serve the canary domain** `use-application-dns.net` as NXDOMAIN from your resolver — Firefox specifically checks this domain on startup and disables its built-in DoH automatically if it doesn't resolve. This is the "correct" opt-out signal and costs you one static zone entry.

Without one of these, a launcher or browser doing its own DoH resolution will silently route around your entire rewrite table and blocklist — the LANCache short-circuit, the launcher toggles, all of it just won't fire for that traffic.

## Complete feature checklist — everything, mapped to where it lives

Every feature discussed is in scope. This table is the build spec: what it is, which layer owns it, and how the caveats get handled instead of being left open.

| Feature | Lives in | Status / how the caveat is handled |
|---|---|---|
| AF_XDP kernel-bypass networking | Layer 1 | Core requirement, not optional |
| RAM answer cache, 8GB floor, hugepage-backed | Layer 2 | Hard floor at boot, configurable ceiling |
| LANCache static rewrite (consistent, own policy table) | Layer 1.5 | Short-circuits before general cache — confirmed, memory-noted |
| Per-launcher on/off toggle | Layer 1.5 | Same policy table, category bit flip, no structural reload |
| AdGuard Home blocklist format ingestion | Layer 3c policy table | Parsed at build time into the mmap'd perfect hash |
| NVMe persistent cache snapshot (instant warm restart) | Layer 3a | mmap + periodic msync, restore on boot |
| Async full query logging | Layer 3b | io_uring, own thread/cores, never blocks answer path |
| NUMA/IRQ pinning, isolated cores | Layer 4 | Network and storage threads never share a runqueue |
| Serve-stale (RFC 8767) | Layer 2 | Answer from expired cache entry when upstream/DNSSEC chain fails, instead of SERVFAIL |
| Prefetching / auto-prefetch | Layer 2 | Re-resolve hot entries before TTL expiry |
| QNAME minimization (RFC 7816/9156) | Recursion path (Layer 2 miss handling) | On by default for all upstream queries |
| QNAME case randomization (0x20) | Recursion path | On by default, no downside |
| DNS Cookies (RFC 7873) | UDP transport layer | On by default, avoids unnecessary TCP fallback |
| Extended DNS Errors (RFC 8914) | All response paths | Every block/rewrite/failure carries a machine-readable reason |
| CNAME cloaking detection | Layer 1.5 triage | Walk the CNAME chain against the policy table, not just the original qname |
| Health-checked forwarder failover | Layer 2 recursion/forwarding | Active health checks, automatic failover, no SERVFAIL storms on a dead upstream |
| DNSSEC validation | Layer 2 recursion path | **On**, paired with serve-stale so a validation failure degrades to stale-but-working; debug toggle to disable validation for troubleshooting only |
| EDNS Client Subnet (ECS) | Forwarder config | **Off by default**, per-forwarder override switch for specific CDNs if you want sharper routing later |
| DNS rebinding protection | Layer 1.5 triage | **On**, but gated by an allowlist keyed off the same policy table — LANCache rewrites, internal zones, and OPNsense/AD-integrated domains are exempted so the protection can't break your own design |
| Response Rate Limiting (RRL) | Authoritative-side only (not this household box) | Flagged for Libereon PoPs; not applied here, tuned threshold if/when it is |
| DoH bypass mitigation | Firewall + zone config | Block known public DoH endpoints on 443, and serve `use-application-dns.net` as NXDOMAIN so Firefox disables its built-in DoH automatically |
| Block/NXDOMAIN pages | Layer 1.5 triage, rewrite to local web server | Per-category page, reason carried via EDE; HTTPS categories need an internal CA or fall back to true NXDOMAIN |
| apt-cacher-ng discovery | Authoritative zone (SRV record), not the rewrite table | `_apt_proxy._tcp.<domain>` SRV record — path-based proxy, not hostname interception; HTTPS mirrors can't be transparently cached at all |
| Apple content caching discovery | Authoritative zone (TXT record), not the rewrite table | `prs/prn/fss/fsn` TXT record on the client search domain, cloud-mediated handshake — DNS only helps cross-subnet/multi-IP discovery |
| Cross-distro support (Debian/Ubuntu/Alpine) | Build/packaging | One static musl binary for all three; systemd unit for Debian/Ubuntu, OpenRC script for Alpine; XDP zero-copy vs generic mode is a deployment choice, not a distro one |
| Never cache failures (SERVFAIL/timeout) | Layer 2 negative-cache logic | Only NXDOMAIN/NODATA are cacheable per RFC 2308; failures use query coalescing + circuit breaker instead, never a stored cache entry |
| Adaptive per-upstream RTT/timeout | Layer 2 recursion/forwarding | SRTT/RTTVAR estimation per forwarder (RFC 6298-style), replaces fixed global timeout |
| Conservative EDNS buffer size + fast TCP fallback | Transport layer | 1232-byte default per DNS Flag Day 2020, immediate TCP fallback on truncation — avoids fragmentation drops on tunnels/coax/lossy links |
| Loss-aware jittered retry / query racing | Transport layer | Jittered backoff instead of fixed retry intervals; optional racing against a second forwarder on paths flagged high-jitter |
| MTU control (static MTU + MSS clamping + PMTUD blackhole detection) | Network layer (OPNsense boundary + interface config) | Fixes the burst-climb-then-collapse sawtooth caused by silently dropped oversized segments on tunneled/mixed-MTU paths |
| TX/RX ring & offload control | Layer 4 / NIC config | Explicit ring sizing, coalescing, and offload settings sized for burst traffic (LANCache chunks) instead of driver defaults; RSS aligned with NUMA pinning so download bursts don't steal cycles from DNS query latency |
| Resolver HA (VRRP/keepalived across the Proxmox cluster) | Deployment | Floating VIP, active/standby or active/active, so a node failure doesn't take out household DNS |
| Client ACLs + per-client rate limiting | Layer 0 / transport | LAN/VPN-only query acceptance, per-client abuse throttling |
| Per-device/per-VLAN policy | Layer 1.5 policy table | Adds a client-subnet dimension to the policy table, not just domain — needed if launcher/blocklist rules should differ per device |
| Automatic blocklist/LANCache list updates with rollback | Layer 3c | Scheduled pull + diff/validate before hot-swap; keep last-good version for instant rollback |
| IPv4/IPv6 Happy-Eyeballs-style racing | Layer 2 recursion | Race A/AAAA rather than trusting DNS answer order, given the HE tunnel's different path characteristics |
| Control-plane API authentication | Management API | Real auth (tokens), not implicit LAN trust |
| Query log retention/rotation policy | Layer 3b | Size/time-based pruning so the NVMe log doesn't grow unbounded |
| mDNS reflection across VLANs | Separate service, same box | For AirPlay/Chromecast-style discovery broken by VLAN segmentation |

## Block / NXDOMAIN pages

Right now a blocked domain in Layer 1.5 just returns NXDOMAIN or a blackhole IP — functional, but a browser just shows its own generic error, and you lose the chance to tell a household member (or yourself, three weeks from now) *why* something got blocked.

**Design:** for categories where you want a page instead of a silent failure (ads, malware, launcher-disabled, parental), rewrite to a dedicated local IP running a small web server, instead of returning NXDOMAIN. Carry the block *reason* (already available via the Extended DNS Errors code from your policy table lookup) through to that web server so it can render the right page — either via separate IPs per category, or one IP with the web server doing its own domain→reason lookup against the same policy table. Categories where you genuinely want a hard failure (e.g., security tooling probes, deliberate NXDOMAIN for testing) stay configurable as true NXDOMAIN, not a redirect.

**The real caveat: HTTPS.** Almost everything blocked today is HTTPS, and a rewritten IP can't present a valid cert for the original domain — the client's browser will show a broken-padlock/certificate-error page instead of your nice block page, unless the device trusts a certificate your block-page server presents. Two paths:
- If the client machines already trust an internal CA (worth checking — you may already have this plumbed through your AD/STELLARAD environment), issue the block-page server a wildcard-ish cert or SAN cert covering the categories you rewrite, signed by that CA, and push trust via GPO/MDM.
- Without a trusted CA on the client, don't fight it — serve real NXDOMAIN for HTTPS-heavy categories (ads/trackers, where a cert warning is actually counterproductive noise) and reserve the block-page treatment for cases where you control the client or the traffic is plain HTTP (launcher-disabled is often a good candidate, since some launcher check-in traffic is HTTP or downgrades gracefully).

## apt-cacher-ng: this one is not a simple hostname rewrite — here's why, and what to do instead

LANCache-style rewriting works because the cache server sits at the same hostname the client already expects and answers HTTP directly for that Host header. apt-cacher-ng doesn't work that way:

- It's a **path-based proxy** — the client is expected to request `http://<acng-ip>:3142/deb.debian.org/debian/...`, with the original mirror hostname embedded *in the URL path*, not resolved via DNS to the proxy's IP. A plain A-record rewrite of `deb.debian.org` → your acng IP would just cause acng to receive requests at `/debian/...` with no idea which upstream mirror they came from, since it isn't listening as `deb.debian.org`, it's listening as itself.
- **HTTPS breaks it entirely.** <cite index="32-1">apt-cacher-ng will obviously fail to serve HTTPS repositories</cite>, and `deb.debian.org` is HTTPS by default on modern releases — no cert to present, no MITM path without your own trusted CA (same caveat as the block pages above, and arguably worse since apt would refuse the connection outright rather than degrade to a warning).
- **The mechanism that actually is DNS-based and does exist**: apt-cacher-ng's auto-discovery tooling (`auto-apt-proxy`) looks for a **DNS SRV record**, <cite index="34-1">`_apt_proxy._tcp.${domain}`</cite>, to find the proxy automatically instead of hardcoding it in `/etc/apt/apt.conf.d/`. This is the correct feature to add to your resolver — publish that SRV record pointing at your acng box in whatever domain your Debian/Ubuntu clients use as their search domain, and any client running `auto-apt-proxy` picks it up with zero manual config, no DNS rewrite trickery involved.

**Recommendation:** add the `_apt_proxy._tcp` SRV record as a proper authoritative zone entry (this is a real DNS feature, fits cleanly alongside your other zones), skip trying to force it through the LANCache-style rewrite table since the underlying protocol doesn't support hostname interception the same way, and standardize your client sources.list entries on plain HTTP mirrors where you want transparent caching without the HTTPS dead end.

## Apple content caching: also not a hostname rewrite — it's a TXT record

Apple's content caching discovery is a cloud-mediated handshake (device asks Apple's discovery service, Apple cross-matches against your caching server's registration by public IP), not devices connecting directly to `swcdn.apple.com`-style hostnames that a rewrite could intercept. Where DNS *does* matter is cross-subnet/VLAN discovery and multi-public-IP households:

- <cite index="19-1">If your network uses multiple public IP addresses such that the content cache might register using a different address than a client uses for discovery, you need to provide both the content cache and clients a list of those addresses via a DNS TXT record</cite>, published in the default search domain your clients use.
- Format: <cite index="20-1">`name._tcp 10800 IN TXT "[prs|prn|fss|fsn]=addressRanges"`</cite> — `prs`/`prn` for public IP ranges, `fss`/`fsn` for favored local IP ranges of your caching servers, so devices prefer your macOS Content Caching VMs over any rogue/neighboring cache.
- <cite index="18-1">This matters more than it looks like on networks with a NAT pool of multiple outbound public IPs</cite> — worth checking whether your ISP/OPNsense WAN setup rotates or pools addresses, since that's the actual failure mode this record fixes.

**Recommendation:** add this as a static TXT record served from your authoritative zone for the search domain your Macs/iOS devices get via DHCP — not the policy/rewrite table, since it's a discovery hint, not a hostname interception. Set the `fss`/`fsn` values to your Content Caching VMs' local subnet so they're always preferred over anything else on the network.

## Cross-distro support: Debian, Ubuntu, Alpine

Three different libc/init combos (Debian & Ubuntu: glibc + systemd; Alpine: musl + OpenRC) means the sane move is **one static binary, not three build pipelines.**

### Build once, statically, against musl — run everywhere
Compile as a fully static binary against the `x86_64-unknown-linux-musl` target regardless of which distro you're deploying to. A static musl binary runs unmodified on Alpine (native libc match) *and* on Debian/Ubuntu (a static binary doesn't care what libc the host has, since it isn't dynamically linking against glibc at all). This collapses "build for three distros" into "build once, ship one artifact, write three thin service-manager wrappers."
```bash
rustup target add x86_64-unknown-linux-musl
cargo build --release --target x86_64-unknown-linux-musl
```
Dependencies that need distro packages only at build/dev time, not runtime (static binary has no external deps once built):
```bash
# Debian / Ubuntu
apt install liburing-dev libbpf-dev musl-tools clang llvm

# Alpine
apk add liburing-dev libbpf-dev musl-dev clang llvm
```

### AF_XDP mode is a virtualization question, not a distro question
Whichever distro you pick, the thing that actually determines your performance ceiling is **how the NIC reaches the process**:
- **Native/zero-copy XDP mode** — needs the physical NIC's driver to support it directly (ixgbe/i40e/ice for Intel, most modern Mellanox), and needs the process to see the actual physical interface, not a bridged veth. This means bare metal, or a VM with SR-IOV VF passthrough, or a privileged LXC with the physical NIC moved in.
- **Generic/SKB XDP mode** — works over any interface, including a standard virtio-bridged NIC in a normal Proxmox VM or LXC. Still meaningfully faster than a plain UDP socket, but you don't get the full zero-copy ceiling from Layer 1.
- This tradeoff is identical on Debian, Ubuntu, and Alpine — it's determined by where you deploy (bare metal / SR-IOV VM / bridged VM / LXC), not which OS. Worth deciding before you pick a target: if you want true zero-copy numbers, this points toward an SR-IOV VF on one of the R640s or a dedicated bare-metal box, not a standard bridged LXC.

### Per-distro service management
- **Debian / Ubuntu (systemd):** standard `.service` unit, `CPUAffinity=` / `AllowedCPUs=` directives for the NUMA/core pinning from Layer 4, hugepages reserved via `/etc/sysctl.d/`.
- **Alpine (OpenRC):** `/etc/init.d/` script, hugepages reserved via `/etc/sysctl.conf` + an OpenRC `local.d` boot script since Alpine doesn't use `sysctl.d` the same way by default.
- Recommend packaging both from one source with **nfpm** (single YAML config → produces `.deb` for Debian/Ubuntu and `.apk` for Alpine) rather than hand-rolling `debian/control` and `APKBUILD` separately.

### Alpine-specific notes
- Alpine's `linux-lts` and `linux-virt` kernel packages both ship `CONFIG_IO_URING` and `CONFIG_XDP_SOCKETS` enabled — confirm on the specific kernel you land on with `zgrep CONFIG_XDP_SOCKETS /proc/config.gz` if available, or check `/boot/config-$(uname -r)`.
- If Alpine is the LXC guest and this box is sharing the Proxmox host's kernel (typical for unprivileged LXC), AF_XDP capability is governed by the **host** kernel config, not anything Alpine ships — same caveat applies to Debian/Ubuntu LXCs too, just worth flagging since Alpine's minimalism sometimes hides which kernel is actually in play.
- musl's `io_uring` support via `liburing` is solid and matches the glibc build path — no functional gap versus Debian/Ubuntu here.

## Stability: never cache a failure

This is a real, documented pain point with Technitium and several other resolvers: a transient upstream failure (timeout, connection refused, SERVFAIL from a flapping link) gets treated like a normal negative answer and sits in the cache for a negative-TTL window — so a link blip that lasts two seconds can leave clients getting cached failures for minutes afterward, long after the link recovered. Fix this at the design level, not as a tuning knob:

- **Only RFC 2308-legitimate negative answers get cached** — NXDOMAIN and NODATA, respecting the zone's SOA minimum/negative-TTL, because those are actual authoritative facts ("this name doesn't exist"). **SERVFAIL, REFUSED, timeouts, and connection-level failures are never written to the cache**, full stop. A failure isn't a fact about the domain, it's a fact about the current state of a link — caching it conflates the two and produces exactly the stuck-failure behavior you're trying to avoid.
- **Query coalescing instead of failure caching, during an active outage.** If an upstream is down and 50 clients ask for the same domain in the same second, don't hit the upstream 50 times *and* don't cache a failure either — collapse concurrent identical in-flight queries into a single upstream attempt and fan the result out to all waiters. This protects the failing upstream from a retry storm without ever writing a poisoned cache entry.
- **Circuit breaker per upstream**, layered on the health-checked failover from before: track a rolling failure rate per forwarder; once it crosses a threshold, stop sending it live traffic and shift to your other forwarders immediately, while a background prober keeps checking it every few seconds. The moment it's healthy again, it's back in rotation automatically — no cached failure state anywhere in this path either, just a live health signal.
- **Serve-stale covers the case where you have history; this covers the case where you don't.** If a domain has never been resolved before and every upstream is down, there's nothing to serve stale — the honest answer is SERVFAIL to the client, but it costs nothing to retry fresh on the very next query the instant a link recovers, because nothing was cached to block that retry.

## Cabling- and link-agnostic transport: coax, fiber, tunnels, whatever's actually in the path

A resolver tuned only for a clean fiber path will misbehave the moment part of your infrastructure runs over something with different latency/jitter/MTU characteristics — and given you're running Libereon PoPs across the US and Frankfurt, an HE IPv6 tunnel, and presumably a cable/coax WAN handoff somewhere in the mix, "assume fiber" isn't a safe assumption here.

- **Adaptive per-upstream RTT estimation, not a fixed timeout.** Track smoothed RTT and RTT variance per forwarder (the same SRTT/RTTVAR approach TCP uses for its retransmission timeout, RFC 6298) instead of one global timeout value. A forwarder answering in 2ms gets a tight timeout and fast retry; a forwarder reached over a higher-latency or jitterier path (coax/DOCSIS upstream, an intercontinental Libereon hop, anything tunneled) gets a timeout sized to its actual observed behavior instead of being falsely marked dead by a timeout tuned for fiber.
- **Conservative EDNS buffer size by default.** <cite index="39-1">An EDNS buffer size of 1232 bytes avoids IP fragmentation on nearly all current networks, based on the IPv6-mandated minimum MTU of 1280 bytes minus header overhead</cite> — this is the DNS Flag Day 2020 consensus, and it matters directly for you: fragmentation is exactly the kind of failure that shows up unpredictably depending on cabling and tunnels (your HE IPv6 tunnel included, which is a classic place for MTU mismatches to bite), and a fragmented UDP response often just silently vanishes on a lossy or MTU-constrained link rather than failing cleanly. Default to 1232, fall back to TCP whenever a response would exceed it — don't chase the larger 1472-ish buffer sizes tuned for "clean 1500-MTU Ethernet only," since that assumption doesn't hold across your actual link mix.
- **Graceful, fast TCP fallback.** Whenever a UDP response is truncated (TC bit set) or would exceed the buffer size, fall back to TCP immediately rather than retry-and-fail over UDP first — this matters more on lossy/high-jitter links (coax, wireless backhaul, congested tunnels) where a second UDP attempt is likely to fail the same way the first one did.
- **Loss-aware retry, not fixed retry counts.** On a shared-medium or lossy link (coax/DOCSIS in particular, where collision/noise-driven loss is common), fixed retry intervals across many clients can synchronize and pile onto the link right after a loss event. Use jittered backoff per retry rather than a fixed interval.
- **Optional query racing on known-flaky paths.** For a forwarder your adaptive RTT tracking flags as high-jitter or lossy, you can race the query against a second, healthier forwarder simultaneously and take whichever answer lands first — hides an individual bad link's latency/loss from the client without you needing to know in advance which physical medium is having a bad day.

## MTU control and TX/RX control — and why that graph looks like that

That burst-climb-then-decay-to-a-floor pattern, repeating, is one of two classic failure modes — worth naming both since the fix is different for each:

1. **PMTU blackhole.** TCP starts a connection, window ramps up (slow start → the climb), eventually sends a full-size segment that's too big for some link in the path (a tunnel, a VPN, a misconfigured MTU hop) — that segment gets silently dropped instead of triggering an ICMP "Fragmentation Needed" response (often because something along the path filters ICMP), so the sender just times out, backs off hard, and restarts small. Window climbs again, hits the same wall, repeats. This is *exactly* the sawtooth shape in that graph, and it's extremely common across exactly the kind of mixed-link environment you're running (HE IPv6 tunnel included).
2. **NIC ring/offload burst overrun.** A burst of packets (a LANCache chunk landing all at once) overruns an undersized RX ring buffer or gets mangled by imperfect offload emulation (common with virtio-net in VMs/LXCs), packets drop, TCP congestion-avoidance backs off hard, ring drains, throughput climbs back up, repeats.

Both need explicit control rather than trusting driver/OS defaults, so this becomes its own layer in the design:

### MTU control
- **Static, explicit MTU per interface/VLAN** rather than relying on auto-negotiation or PMTUD alone — set it once, verify it, don't guess.
- **TCP MSS clamping at the OPNsense boundary** for any tunneled or encapsulated path (your HE IPv6 tunnel is the obvious one). This is the actual fix for failure mode #1: clamping MSS means TCP never *tries* to send a too-large segment in the first place, so it doesn't matter whether ICMP Fragmentation Needed messages are getting filtered somewhere in the path — the blackhole never gets a chance to trigger.
- **Active PMTUD blackhole detection.** Don't just hope ICMP works — periodically probe and confirm whether Fragmentation Needed messages are actually arriving on each path; if they're not, that's your signal to force MSS clamping on that path rather than relying on a mechanism you've confirmed is broken.
- **Jumbo frames (9000 MTU) as an explicit opt-in, internal-only.** Fine for purely internal high-throughput segments you control end-to-end (LANCache origin ↔ Proxmox cluster, iSCSI/NVMe backend links) — never on anything that touches a path you don't fully control, since one mismatched hop anywhere in that chain reproduces failure mode #1.

### TX/RX control
- **Explicit RX/TX ring buffer sizing** (`ethtool -g`), sized for burst tolerance rather than left at driver defaults — default sizes (especially on virtio-net) are frequently too small for the kind of all-at-once chunk delivery LANCache and game CDN traffic produces, which is exactly failure mode #2.
- **Interrupt coalescing tuned deliberately** (`ethtool -c`) — too-aggressive coalescing batches packet delivery in a way that itself creates artificial burstiness, working against you here.
- **Explicit control over offloads** (GRO/GSO/TSO/LRO, checksum offload) instead of trusting whatever the driver defaults to. This matters especially inside virtualized NICs (virtio-net in a Proxmox VM/LXC), where offload emulation is sometimes incomplete and can itself be the source of the drop-and-recover pattern rather than a fix for it — worth testing with offloads selectively disabled if the pattern persists after ring sizing and MTU fixes.
- **RSS/multi-queue alignment with your Layer 4 NUMA pinning** — make sure the queues carrying burst-heavy LANCache/download traffic aren't sharing a core or a NUMA node with the queues your DNS AF_XDP path depends on, so a download burst on one never steals cycles from query latency on the other.

## What's still missing

The design so far covers speed, stability, and cache correctness. These are the pieces that matter once it's actually running as your household's single point of DNS failure:

- **Resolver-level redundancy, not just upstream redundancy.** Everything so far makes upstream *links* resilient, but the resolver box itself is still a single point of failure. You've got a 3-node Proxmox cluster — run this as an active/standby (or active/active) pair with VRRP/keepalived owning a floating VIP, so a node reboot or crash doesn't take out DNS for the whole house mid-download.
- **Access control and per-client rate limiting.** Right now the design assumes trusted LAN clients. Add an ACL restricting who can query at all (LAN/VPN subnets only, nothing internet-facing), and per-client query rate limiting so one misbehaving device (compromised IoT gadget, a runaway script) can't hammer the resolver or get used to bounce traffic elsewhere.
- **Per-device / per-VLAN policy, not just global toggles.** Launcher toggles and blocklists are currently global. If this ever needs to differentiate — a kid's device with stricter blocking, your own with everything open, an IoT VLAN with almost nothing allowed — the policy table needs a client-subnet dimension, not just a domain dimension. Worth deciding now whether that's in scope, since it changes the table's key structure.
- **Automatic blocklist/LANCache list updates, with validation before applying.** Community lists (hagezi, the LANCache cache_domains repo) update regularly. Pull them on a schedule, but diff and sanity-check before hot-swapping the live mmap'd table — a malformed upstream list update shouldn't be able to brick resolution for the whole house. Keep the previous good version to roll back to instantly if a new list is bad.
- **IPv6/IPv4 racing (Happy Eyeballs-style).** Given the HE tunnel is a different path with different characteristics than native IPv4, query A and AAAA simultaneously and let the client's actual connection behavior (not just DNS answer order) determine preference — avoids a slow/broken IPv6 path silently degrading everything if IPv6 is preferred by default without evidence it's actually the faster path right now.
- **Control-plane API auth.** Anything that can flip launcher toggles or edit rewrites needs real authentication (API tokens, not just "it's on the LAN so it's fine") — this thing has more leverage over your network than a normal appliance.
- **Query log retention and rotation.** The NVMe async logging from Layer 3b needs an actual retention policy — size or time-based rotation/pruning — or it just grows forever.
- **mDNS reflection across VLANs**, if your household devices are segmented (AirPlay/Chromecast/etc. discovery breaks across VLAN boundaries by design) — separate concern from unicast DNS but often lands on the same box in a homelab.

Not urgent, but worth a mention: all of DNSSEC validation, DoH/DoT serving, and the Apple content-caching TXT record assume accurate system time — your chrony LXC already covers this, just flagging the dependency exists.

## Minimum requirements

| Resource | Floor | Comfortable | Why |
|---|---|---|---|
| CPU | 4 cores | 6-8 cores | Needs isolated cores for the AF_XDP network fast path, separate from io_uring logging/snapshot threads, separate from control-plane/API — 2 cores total works for a quiet home LAN but leaves no real isolation margin |
| RAM | 12GB | 16GB+ | 8GB hard floor for the hugepage-backed cache itself (from earlier), plus OS overhead, logging buffers, and the mmap'd policy table |
| Storage | 20GB NVMe | Whatever you've already got on the DC U.2 drives | Cache snapshot is a few GB, policy table is tens of MB even at millions of blocklist entries, query log size depends entirely on your retention setting |
| Kernel | 5.4+ | 5.15+ (Debian 12 / Ubuntu 22.04+ default) | AF_XDP needs 4.18+ minimum, but io_uring's more advanced ops (`IORING_SETUP_SQPOLL` and friends) and general maturity really want 5.11+ |
| NIC | Any (generic/SKB XDP mode) | Intel ixgbe/i40e/ice or Mellanox mlx5 (native zero-copy XDP) | Driver support for true zero-copy is a short list — everything else still works, just capped below the full ceiling |

## Can this run in an LXC — yes, with a fork in the road

LXC is a good fit philosophically (near-zero virtualization tax, which matters when the whole point is squeezing out microseconds), but which mode of AF_XDP you get depends on how you configure it:

**Generic/SKB mode — works in a standard LXC, privileged or not, no special surgery.** Runs over the normal Proxmox veth+bridge like any other container's networking. This is the easy path, gets you meaningfully better than plain UDP sockets, and is where I'd actually start — validate the whole design here first.

**True zero-copy mode — needs a privileged LXC with the physical NIC passed in directly** (`lxc.net0.type = phys` moves the actual physical interface into the container). This is the same constraint as the "AF_XDP mode is a virtualization question" point from earlier — it's not really an LXC-specific limitation, VMs have the equivalent SR-IOV requirement. The practical consequence: that NIC is now unavailable to the Proxmox host or any other guest on that node, so you'd want the target R640 to have a second NIC free for host/management traffic before going this route.

Three other things that need attention specifically because it's a container, not a VM:

- **io_uring and Proxmox's default LXC seccomp profile.** Proxmox's stock seccomp profile has historically restricted `io_uring_setup`/`io_uring_enter` for containers (there's real CVE history behind that caution). You'll need a custom seccomp profile permitting those syscalls — a deliberate, scoped exception, not `lxc.seccomp.profile = unconfined`.
- **Hugepages are host-wide, not per-container.** Reserve them at the Proxmox host level (`vm.nr_hugepages` via sysctl on the node itself), then bind-mount `/dev/hugepages` into the LXC. That 8GB+ floor comes out of the host's general RAM pool permanently while reserved — worth accounting for against whatever else is scheduled on that node.
- **NVMe access**: easiest as a bind-mounted directory/ZFS dataset from the host rather than raw block-device passthrough, unless you specifically want the container issuing raw block I/O — either works, bind-mount is less fuss.

**Recommended path:** stand it up as a privileged LXC in generic/SKB XDP mode first, on a node with hugepages reserved and NVMe bind-mounted, prove out the whole design (cache, policy table, failure handling, all of it) — then decide later whether the jump to a dedicated physical NIC for true zero-copy is worth taking that NIC away from the host.

## Open question for you

To tune the NUMA/core-pinning section for real instead of generically: which box is this landing on (one of the R640s in the Proxmox cluster, the R630, or dedicated hardware), what NIC (10G/25G/100G), and how many U.2 slots/drives do you actually have free to dedicate to this vs. TrueNAS?
