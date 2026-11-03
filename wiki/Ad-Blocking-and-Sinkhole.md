# Ad Blocking and the Sinkhole

Two separate questions, often confused:

1. **Does the name get blocked?** Blocklists, allowlist, categories, pause.
2. **What does a blocked client see?** `blockedResponse` — four modes, different trade-offs.

This page covers both, and then the part most projects leave out: what the sinkhole cannot do.

## Blocklists

Any of these formats, mixed freely:

```
# hosts file
0.0.0.0 ads.example.com

# domain per line
ads.example.com

# Adblock-style
||ads.example.com^
```

Add them in the console's Blocking tab (one URL per line) or in `blocklists`. Refresh runs
every `blocklistRefreshHours` (24 by default), and a failed refresh keeps the previous set
rather than emptying your blocking.

### Choosing a list: ads, or destinations?

The number that matters is not how many domains a list holds, but **whether it blocks things
people need to reach**. Three different jobs get sold as "ad blocking":

| Job | Example lists | Blocks | Leaves working |
|---|---|---|---|
| **Ads and trackers only** | OISD small, Peter Lowe | Ad, tracking, telemetry and phishing domains | Every destination — TikTok, Instagram, YouTube |
| **Ads plus annoyances** | HaGeZi Multi LIGHT / PRO | The above, plus metrics, scams, pop-ups | Most destinations; occasional embeds |
| **Content** | HaGeZi social / nsfw, Blocklist Project tiktok / porn | Whole services | Nothing — the app stops loading |

The console's **Blocking → Blocklists** tab groups these into two sections. *Ads only* is the
one to pick for a school, office, or any network where filtering must not become a content wall:
it installs OISD small and Peter Lowe together and blocks no browsing destination. *Full
protection* adds HaGeZi PRO or the AdGuard DNS filter — and that one is a bundle, whose own
header lists a **Social Media filter** component, so it can interfere with social apps.

Read the header of any list before deploying it:

```
! Title: ...
! Description: ...
! Last modified: ...
! Expires: ...
```

A list whose `Last modified` is months old is dormant or abandoned; a domain count tells you
nothing about freshness. Both checks take ten seconds and predict breakage better than size does.

### Allowlist, pause, and "why"

- **Allowlist** (`blockAllowlist`) overrides every list for a domain *and its subdomains*.
  One-click from the query log. It does not edit the downloaded list, so a refresh can't
  undo it.
- **Pause** stops blocking for a bounded time (up to 7 days). Useful when a site breaks and you
  need to know whether blocking is the cause.
- **Why** answers "why is this blocked?" for a single domain, including which rule matched, or
  which of the four reasons applied instead:

```sh
curl -s -H "x-api-token: $TOKEN" \
  'http://127.0.0.1:5380/api/blocking/why?domain=ads.example.com'
```

## Response modes

| Mode | Answer | What the client sees | Use when |
|---|---|---|---|
| `nxdomain` | NXDOMAIN | "This domain does not exist" | Default. Fastest, smallest, most cacheable |
| `zeroip` | `0.0.0.0` / `::` | A connection refused instantly | The client handles null routes gracefully |
| `sinkhole` | A real address on your LAN | A connection that hangs or resets | You want blocking to look like an ordinary network |
| `blockpage` | An address serving HTTP 200 | A page explaining the block | You want the user to know *why* |

### Why `sinkhole` is the interesting one

Blocklist detectors — the scripts sites run to notice you're blocking their ads — mostly ask
"did DNS fail?" NXDOMAIN and `0.0.0.0` both answer yes, loudly. `sinkhole` answers with an
address that belongs to your own network, so the response is indistinguishable from any other
LAN host from the client's point of view.

The address is **discovered, not configured**. At boot the resolver asks the kernel which
source address it would use for the internet (a UDP connect, no packets sent), scans the
non-virtual interfaces as a fallback, and hands out its own address *on the client's own
subnet* — a box serving two VLANs gives each one an address it can actually route to.
`sinkholeIP` overrides all of that, and `sinkholeIPv6` covers the v6 side.

### What keeps it from looking like a filter

A filter is recognizable by its *constants*. Every blocked name getting the same address,
the same TTL, and a stub that answers any Host header is a fingerprint, even when each
individual answer looks plausible.

- **Per-name TTL.** A blocked name gets a TTL derived from the name itself, in the
  300–3600 s range real zones use. It is deterministic: ask twice and you get the same
  number, ask ten domains and you get ten different zones.
- **NODATA with an SOA.** A blocked AAAA with no `sinkholeIPv6` returns `NOERROR` with no
  answers, plus the synthetic zone SOA a recursor would have cached the negative under.
  NXDOMAIN would say "this domain does not exist"; NODATA says "not this type", which is
  the truth and is what every real dual-stack-less zone returns.
- **One answer per outcome.** A CNAME-cloaked tracker gets the same reply as a plain ad
  hit. Anything else is a map of which blocks to look at.
- **No Extended DNS Errors.** EDE 15/17 is a machine-readable "blocked"/"filtered". In
  stealth mode nothing on a block path attaches one, including the NXDOMAINs that still
  have to happen — a disabled launcher category, a `blockAll` device group.
- **A stub that only serves blocked names.** Request `/collect` from a name that is not on
  a blocklist and you get a plain `404`, like any other host that does not run that
  service. An open stub is an oracle: it proves a sinkhole exists where nothing should be.

When sinkhole mode is active the resolver also runs a stub HTTP server on port 80 so the
connection completes rather than timing out. It echoes CORS headers, so an XHR that expects a
response gets one instead of hanging until it gives up. That's what makes the mode behave like
a network rather than a black hole.

### What each mode costs you

- `nxdomain` is the most cache-friendly and the most obvious.
- `zeroip` sometimes leaks into client diagnostics as "0.0.0.0" and confuses users.
- `sinkhole` needs port 80 free on the resolver host, and a LAN address that isn't already
  serving something you care about.
- `blockpage` needs `blockPageIP` set and `blockPagePort` (8053) reachable; it makes the block
  explicit, which is exactly what a detector wants to see.

## The honest ceiling

A sinkhole defeats "did DNS fail?" detection. It does not defeat:

- **Certificate checks.** If the stub answers TLS, the certificate belongs to your host, not
  the requested domain. Anything validating it will notice.
- **Pinned clients.** An app with a pinned certificate doesn't care what DNS says.
- **In-page verification.** A script that fetches a resource through a path DNS doesn't control
  — a hard-coded IP, a proxy, a Service Worker cache — never asks the resolver at all.
- **DoH/DoT on the client.** A browser with its own secure DNS bypasses the resolver entirely.
  This is the single most common reason "blocking stopped working", and no resolver-side
  setting fixes it. See [Troubleshooting](Troubleshooting#blocking-stopped-working).

The design goal is narrower and achievable: a blocked name should look like a normal name, and
the resolver should be zero-config to set up. It is not invisibility, and treating it as such
will produce a network you can't debug.

## Verifying

```sh
# 1. Is it blocked at all?
curl -s -H "x-api-token: $TOKEN" 'http://127.0.0.1:5380/api/blocking/why?domain=ads.example.com'

# 2. What does the answer look like?
dig @127.0.0.1 ads.example.com A +noall +answer

# 3. Which address is the sinkhole using, and is the stub up?
curl -s -H "x-api-token: $TOKEN" http://127.0.0.1:5380/api/stats | grep -o '"stealth":{[^}]*}'
```

In `sinkhole` mode, step 2 should return an address on your LAN and nothing else — no
NXDOMAIN, no `0.0.0.0`.

## Throughput and memory

Blocklists are held as a normalized set, indexed by suffix, so a lookup costs a few string
operations regardless of list size. `/api/stats` reports `memory.blockReasons` and
`memory.memEvictions`; if the latter climbs steadily, `cache.maxHeapMB` is the setting to raise.

## Categories, briefly

Categories are a separate mechanism from blocklists: they *rewrite* a domain to a local cache
(games via LANCache, for example) rather than blocking it. A disabled category falls through to
normal resolution and is logged as `launcher-off`. The console's import helper builds one from
the uklans list if you passed `SD_CACHE_IP` during install, or from the API:

```sh
curl -s -X POST -H "x-api-token: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"defaultTarget":"192.168.9.20"}' \
  http://127.0.0.1:5380/api/import-uklans
```
