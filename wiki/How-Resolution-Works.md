# How Resolution Works

One query, in the order the server handles it. Every stage can end the query; the ones that do
are the reasons the rest of the configuration exists.

## The path

1. **ACL and rate limit.** `clientAcl` (empty = allow all), then `rateLimitPerClientQps` if set.
2. **Loop guard.** A query arriving from one of `loopPeers`, or asking for a zone we forward to
   ourselves, is refused rather than forwarded forever.
3. **Local records.** `localRecords` are authoritative and answered directly.
4. **Internal zone check.** The name is matched against `internalZones` by suffix, not by
   substring: `printer.lan` matches `lan`, `lanparty.example` does not.
5. **Conditional forwarder.** The longest matching zone in `conditionalForwarders` wins — an AD
   `corp.example.com` forwarder beats a generic `example.com` one.
6. **Category rewrite.** LANCache/game-CDN categories rewrite the answer to a local cache
   address instead of resolving normally. Categories can be toggled without a restart.
7. **Blocklist.** Checked against every list, then against `blockAllowlist`. The allowlist wins,
   always, and there is no "remove from list" step — the entry stays in the list and is masked.
8. **Cache.** A live entry is served immediately. An expired entry is served *stale* while a
   refresh runs behind it, unless the name is internal.
9. **Upstream, hedged.** The healthy upstream with the lowest smoothed RTT goes first. Silence
   for `hedgeDelayMs` starts the next one in parallel; first usable answer wins.
10. **Normalize, dedupe, clamp.** Answers are deduplicated, and internal answers have their TTL
    clamped to `internalTtlCap` before they leave.
11. **Store.** The result goes into the cache with a TTL bounded by `minTtl`/`maxTtl`, and
    negative answers by `negMaxTtl`.

## Why this order

**Blocking before the cache.** If the cache were checked first, a name would keep resolving
from cache after you added it to a blocklist until the entry expired. Blocking first makes a
list change take effect on the next query.

**Allowlist after blocking.** The allowlist is a mask, not a filter. That means unblocking a
domain doesn't require editing a downloaded list that will be replaced on the next refresh.

**Internal before cache.** Internal names bypass the ordinary cache TTL rules entirely
(`internalServeStale: false`), because the network's own view of a device is the only
authority and it changes without warning.

**Hedge after cache.** Hedging costs an extra upstream query. Paying that on a cache hit would
be pure waste, so it only happens on the miss path.

## The hedging timeline

```
t=0     upstream A  ──────────────────────────────►  210 ms
t=60    upstream B  ─────────►                       70 ms   ◄── winner
                                                 result at 130 ms
```

Without hedging, the same query returns at 210 ms. Without a cache and with plain failover it
returns at 210 ms or later, depending on the timeout. The 60 ms delay is a bet that the fast
upstream usually wins — below that, hedging doubles your upstream traffic for very little gain.

`race: true` sets the delay to 0 and asks everyone every time. It's the right choice only when
upstreams are on very different paths and the traffic doesn't matter.

## Cache semantics

| Situation | Behaviour |
|---|---|
| Fresh entry | Served from memory |
| Expired entry, `serveStale: true`, not internal | Served immediately; refresh runs behind it |
| Expired entry, internal name | Not served; the query goes out |
| Entry older than `serveStaleMaxAge` | Dropped |
| Popular entry near expiry, `prefetch: true` | Refreshed before a client asks |
| Heap over `maxHeapMB` | Evicted by size/LRU until under budget |

The difference between "fast" and "feels fast" is almost entirely the stale-serve path: a
client waits for a network round trip it never notices.

## Normalization and dedupe

Upstreams lie in small ways. Duplicate A records, the same address with different TTLs, and
CNAME chains that loop back are all common. Before an answer is cached or returned:

- duplicate records are collapsed;
- TTLs within one answer are reconciled;
- the response's own TTL is bounded so a client can't hold an answer past the point where the
  resolver would;
- internal answers are clamped to `internalTtlCap` (30 s by default).

That last step is what makes renaming work. The resolver can't reach into a client's cache;
the only lever it has is not handing out long-lived answers in the first place.

## Multi-worker

With `workers: 0` (or an explicit count) the resolver forks one process per core, capped at 8.
Each worker has its own cache; `/api/stats` aggregates them, which is why the console can show
a cache hit rate above what any single worker sees. Writes to `config.json` are serialized
through the primary so workers can't interleave and corrupt the file.

## Reading the disposition field

Every logged query carries a short disposition, which is the fastest way to answer "why did
this resolve the way it did":

| Disposition | Meaning |
|---|---|
| `cache` | Served from a live entry |
| `cache-stale` | Served stale, refresh in flight |
| `upstream` | Answered by a forwarder |
| `internal` | Answered inside an internal zone or forwarder |
| `blocked` | Matched a blocklist |
| `allowed` | Matched the allowlist and would otherwise have been blocked |
| `launcher-off` | Category rewrite, category disabled |
| `rebind-blocked` | Rebinding protection dropped the answer |
| `loop` | Refused by the loop guard |
