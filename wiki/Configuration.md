# Configuration

Everything lives in `/opt/stellardns/config.json`. Most of it is editable from the console;
some of it is not, and those keys need a file edit and a restart. The console's Config panel
shows the running values, which is the authoritative answer to "what is it actually doing".

`config.example.json` in the repo is the starting point for a fresh install. A few keys exist
in the code's defaults but are not in that file yet — they're marked **not in example** below
and take their default when absent.

## DNS listener

| Key | Default | Meaning |
|---|---|---|
| `dns.host` | `"0.0.0.0"` | IPv4 bind address |
| `dns.host6` | `"::"` | IPv6 bind address |
| `dns.port` | `53` | UDP and TCP port |
| `dns.tcp` | `true` | Also listen on TCP (needed for large answers and zone transfers from clients) |
| `dns.ednsUdpSize` | `1232` | Advertised EDNS0 payload; 1232 avoids fragmentation |
| `dot` / `dotPort` | `true` / `853` | DNS-over-TLS listener |
| `doh` / `dohPort` | `true` / `8443` | DNS-over-HTTPS listener |

## Console

| Key | Default | Meaning |
|---|---|---|
| `web.host` | `"0.0.0.0"` | Console bind address. Set `127.0.0.1` behind a reverse proxy |
| `web.port` | `5380` | Console port |
| `web.apiToken` | `""` | Master API token for `x-api-token`. Empty means token auth is off and only sessions work |

## Upstreams and transport

| Key | Default | Meaning |
|---|---|---|
| `upstreams` | Cloudflare, Quad9 | `{name, address, port}`. `protocol`/`hostname` allow DoT/DoH upstreams |
| `race` | `false` | Send every query to all upstreams at once; first answer wins. Maximum speed, maximum load |
| `hedge` | `true` | **not in example.** Start upstream 2 after `hedgeDelayMs` of silence from upstream 1 |
| `hedgeDelayMs` | `60` | **not in example.** Silence before hedging. `race: true` overrides this to 0 |
| `timeoutMs.min/max/initial` | `250/3000/800` | Adaptive per-upstream timeout bounds |
| `circuit.windowSize` | `20` | Samples in the health window |
| `circuit.failThreshold` | `0.5` | Failure ratio that opens the circuit |
| `circuit.probeIntervalMs` | `3000` | How often an open circuit is probed |
| `failoverJitter` | `true` | Desynchronize retries across clients |
| `qnameMinimization` | `true` | Send only the next label upstream, not the full name |
| `dnsCookies` | `true` | Send EDNS COOKIE to upstreams |
| `ecs` | `false` | Send EDNS Client Subnet. Off by default: it leaks topology and most home networks don't need it |
| `ecsPrefixV4` / `ecsPrefixV6` | `24` / `56` | Prefix length when `ecs` is on |
| `happyEyeballs` | `false` | Prefer AAAA when both families are available |
| `filterAAAA` | `false` | Return NODATA for public AAAA: `true`, or an array of client CIDRs such as `["192.168.1.0/24"]` to scope it. Returns NODATA rather than NXDOMAIN so clients fall back to IPv4 immediately. The case it exists for: clients that are IPv4-only behind a 6in4/HE tunnel, where a reachable-looking AAAA sends them into a path that does not work. Local records, internal zones and LANCache `target6` are unaffected. Set the array in `config.json`; the console shows the scope but toggles only on/off |
| `dnssec` | `"passthrough"` | `passthrough`, or strict modes with `dnssecStrictDomains` |
| `workers` | `0` | Resolver processes; `0` means one per core, capped at 8 |

### Hedging, in one paragraph

A query goes to the fastest healthy upstream. If that upstream hasn't answered within 60 ms,
the same question is sent to the next one **in parallel**; the first usable answer wins and
the loser is discarded. That is different from failover, which waits for a timeout, and
different from racing, which always asks everyone. Measured effect on a two-upstream setup
with one degraded resolver: p95 miss latency drops from ~1.2 s to well under 100 ms.

## Cache

| Key | Default | Meaning |
|---|---|---|
| `cache.maxEntries` | `150000` | Hard entry count |
| `cache.maxHeapMB` | `512` | Memory budget; evicts before the process gets interesting |
| `cache.minTtl` | `5` | Floor for cached TTL |
| `cache.maxTtl` | `86400` | Ceiling for cached TTL |
| `cache.negMaxTtl` | `900` | Ceiling for negative (NXDOMAIN/NODATA) caching |
| `cache.serveStale` | `true` | Answer from expired entries while revalidating |
| `cache.serveStaleMaxAge` | `259200` | How old a stale entry may be (3 days) |
| `cache.prefetch` | `true` | Refresh popular entries before they expire |
| `cache.prefetchWindow` | `10` | Seconds before expiry that prefetch triggers |
| `cache.snapshotIntervalSec` | `300` | Persist the cache to `data/` |

Stale serving is what makes a cold upstream invisible: a client gets an answer in
microseconds while the refresh happens behind it. Internal names are excluded — see below.

## Internal names

| Key | Default | Meaning |
|---|---|---|
| `internalZones` | `[]` | Zones that must never leak upstream, e.g. `["lan", "home.arpa", "local"]` |
| `conditionalForwarders` | `[]` | `{zone, upstreams:[{address,port}]}` for AD domains, Pi-hole upstreams, etc. |
| `internalFallback` | `"auto"` | Where internal names go when no forwarder matches. `auto` uses the detected gateway |
| `internalTimeoutMs` | `700` | Timeout for internal lookups |
| `internalTtlCap` | `30` | **not in example.** TTL ceiling for internal answers on the wire |
| `internalServeStale` | `false` | **not in example.** Serve stale data for internal names. Leave false |
| `selfRecord` | `true` | Answer the resolver's own hostname with its own address |
| `localRecords` | `[]` | Static records, same shape as a zone entry |
| `clientNames` | `{}` | IP-to-label map for the console's client list |
| `forwardLoopGuard` | `true` | Refuse to forward to an address that is us |
| `loopPeers` | `[]` | Known peer resolvers, for loop detection across hosts |
| `reverseForwarders` | `[]` | Upstreams for private PTR lookups |

`internalServeStale: false` and `internalTtlCap: 30` are the two settings that fix stale
Bonjour names. Turning either back on reintroduces the duplicate-hostname problem; see
[Internal Names and Bonjour](Internal-Names-and-Bonjour).

## Blocking

| Key | Default | Meaning |
|---|---|---|
| `blocklists` | `[]` | URLs; hosts-file, domain-per-line, and Adblock-style syntax |
| `blocklistRefreshHours` | `24` | Refresh interval |
| `blockedResponse` | `"nxdomain"` | `nxdomain`, `zeroip`, `sinkhole`, or `blockpage` |
| `blockAllowlist` | `[]` | Domains (and subdomains) that override every list |
| `blockPagePort` | `8053` | HTTP server for `blockpage` mode |
| `blockPageIP` | *(unset)* | Address handed out in `blockpage` mode |
| `sinkholeIP` | `""` | IPv4 handed out in `sinkhole` mode. Empty means auto-discover |
| `sinkholeIPv6` | `""` | IPv6 equivalent, optional |
| `blockingPausedUntil` | `0` | Epoch ms; set by the console's pause button |

The four response modes and what each one exposes are covered in
[Ad Blocking and the Sinkhole](Ad-Blocking-and-Sinkhole).

## Security and limits

| Key | Default | Meaning |
|---|---|---|
| `clientAcl` | `[]` | Allowed client CIDRs. Empty means everyone |
| `rateLimitPerClientQps` | `0` | Per-client limit; `0` disables it |
| `rebindingProtection` | `true` | Drop answers pointing at private addresses |
| `rebindingAllow` / `rebindingAllowlist` | `[]` | Exceptions to rebinding protection |

## Logging

| Key | Default | Meaning |
|---|---|---|
| `log.ringSize` | `2000` | Entries kept in memory for the console |
| `log.file` | `true` | Write to disk |
| `log.maxFileBytes` | `52428800` | 50 MB rotation threshold |
| `log.keepFiles` | `3` | Rotated files retained |

## Editing safely

```sh
sudo cp /opt/stellardns/config.json /root/config.json.$(date +%s)
sudo nano /opt/stellardns/config.json
sudo systemctl restart stellardns
curl -s http://127.0.0.1:5380/api/version
```

The service validates JSON at boot. If the file is unparseable it recovers from
`config.json.bak`, keeps the broken copy as `config.json.corrupt`, and says so in the log —
see [Troubleshooting](Troubleshooting#configjson-is-corrupt-or-was-recovered).
