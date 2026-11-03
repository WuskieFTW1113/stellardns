# Console and API

The console at `:5380` is a static page talking to the same JSON API you can call yourself.
There is no separate backend for it, no GraphQL layer, no websocket. If the console can do it,
an endpoint does it — which makes scripting the resolver straightforward.

## Authentication

Two mechanisms, one check:

| Mechanism | How | When to use |
|---|---|---|
| Session cookie | `POST /api/login` with `{username,password}`; sets `sdsid` (`HttpOnly`, `SameSite=Strict`) | Browser, console |
| Master token | `x-api-token: <config.web.apiToken>` header | Scripts, dashboards, Home Assistant |

`/api/login`, `/api/logout`, `/api/whoami` and `/api/version` are public. **Everything else
requires auth** and returns `401 {"error":"bad or missing token"}` without it.

`/api/version` being public is deliberate: it's the installer's post-upgrade probe and has to
work before any password exists. It exposes version, PID, uptime and a short hash of the loaded
`server.js` — nothing sensitive.

If `web.apiToken` is empty, token auth is off and only sessions work. Setting it to a value of
at least 16 characters enables token auth; the console refuses shorter values on restore.

## Endpoints

Grouped by what they're for. All paths are relative to `http://<host>:5380`.

**Read**

| Endpoint | Returns |
|---|---|
| `GET /api/stats` | Aggregated counters, QPS, hit rate, per-upstream health, config summary |
| `GET /api/log?n=200` | Recent queries, oldest first |
| `GET /api/analytics` | Top domains, clients, blocked names, disposition breakdown |
| `GET /api/metrics` | Prometheus text format |
| `GET /api/version` | Running code identity (public) |
| `GET /api/whoami` | Session user and whether the token matched (public) |
| `GET /api/category/full` | Every category with its domains |
| `GET /api/blocklists` | Configured lists and refresh state |
| `GET /api/forwarders` | Conditional forwarders, internal zones, detected gateway |
| `GET /api/localrecords` | Static records |
| `GET /api/clients/names` | Client IP labels |
| `GET /api/users` | Usernames and roles (never hashes) |
| `GET /api/backup` | Full config as a download |

**Resolve and diagnose**

| Endpoint | Purpose |
|---|---|
| `GET /api/resolve?name=&type=` | Resolve through the real path, without touching the query log |
| `GET /api/blocking/why?domain=` | Which rule (or allowlist/pause) decided |
| `GET /api/gen/ad-domain` (POST) | Generate an AD forwarder + reverse zone from a domain and DC list |

`/api/resolve` is the one to reach for when a user says "this name is broken". It runs local
records, zones, rewrites, blocklists and cache exactly as a client would, and returns the
answers with timing:

```sh
curl -s -H "x-api-token: $TOKEN" \
  'http://127.0.0.1:5380/api/resolve?name=store.steampowered.com&type=A'
```

```json
{"name":"store.steampowered.com","type":"A","ms":3,"rcode":"NOERROR","ad":false,
 "answers":[{"name":"store.steampowered.com","type":"A","ttl":300,"data":"..."}]}
```

**Write**

| Endpoint | Purpose |
|---|---|
| `POST /api/toggle` | `{category, enabled}` |
| `POST /api/category` | Create or update `{category, target, target6, domains}` |
| `POST /api/category/delete` \| `/rename` \| `/move-domain` \| `/add-domain` \| `/remove-domain` | Category edits |
| `POST /api/flush` | Drop the entire cache |
| `POST /api/blocklists` | Replace the list set and refresh |
| `POST /api/blocklists/refresh` | Refresh now |
| `POST /api/blocklist/allowlist` \| `/allow` \| `/unallow` | Allowlist edits |
| `POST /api/blocking/pause` | `{minutes}`, 0 resumes; capped at 10080 |
| `POST /api/settings` | Whitelisted runtime settings (see below) |
| `POST /api/forwarders` | Conditional forwarders, internal zones, reverse forwarders |
| `POST /api/localrecords` | Replace static records |
| `POST /api/upstreams` | Replace the upstream list |
| `POST /api/clients/names` | Replace the IP-to-name map |
| `POST /api/import-uklans` | Import game CDN categories, optional `defaultTarget` |
| `POST /api/subnetpolicies` | Replace subnet policies |
| `POST /api/passwd` | Change a password (old password required unless using the master token) |
| `POST /api/users/add` \| `/users/delete` | User management |
| `POST /api/backup/restore` | Restore a backup file |

### What `/api/settings` accepts

Only these keys, and only these — the endpoint is deliberately not a config editor:

`race`, `ecs`, `ecsPrefixV4`, `ecsPrefixV6`, `qnameMinimization`, `happyEyeballs`,
`filterAAAA`, `dnssec`, `rebindingProtection`, `rebindingAllow`, `dnsCookies`,
`caseRandomization`, `failoverJitter`, `dohCanaryNxdomain`, `blockedResponse`, `blockPageIP`,
`sinkholeIP`, `sinkholeIPv6`, `blockingPausedUntil`, `clientNames`, `clientAcl`,
`rateLimitPerClientQps`, `internalZones`, `workers`, `hedge`, `hedgeDelayMs`, `internalTtlCap`,
`internalServeStale`, plus a `cache` object merged into the existing one.

Anything else needs a file edit. `sinkholeIP` is validated as IPv4 and `sinkholeIPv6` as IPv6;
a bad value is a `400`, not a silent fallback.

## DoH, both shapes

RFC 8484 wire format — `GET ?dns=<base64url>` or `POST` with `application/dns-message` — and a
JSON form selected by `?name=`:

```sh
# JSON
curl -s 'https://<host>:8443/dns-query?name=example.com&type=A'

# Wire
curl -s 'https://<host>:8443/dns-query?dns=...' -H 'accept: application/dns-message'
```

The JSON response is `application/dns-json`, the shape `dig`-style tooling and most DoH
clients expect. `?name=` is the switch; no `Accept` header is required.

## Prometheus

`GET /api/metrics` returns text format, token required. Point a scraper at it and you get
query counts, cache hit rate, per-upstream success and RTT, block counts and memory — the same
numbers the console graphs.

```yaml
scrape_configs:
  - job_name: stellardns
    metrics_path: /api/metrics
    static_configs:
      - targets: ['192.168.9.10:5380']
    # token via header in a real config, not a query param
```

## Backups

`GET /api/backup` downloads a JSON file with `format`, `version`, `exportedAt` and the whole
config. Restore validates structure — `dns`, `web`, `upstreams` — before replacing anything,
preserves the current `web.apiToken` unless the backup has a valid one, and reloads indexes.

Restore does **not** restart listeners. A restored `web.port` or `dns.port` takes effect on the
next restart, and the response says so.

## Scripting notes

- Use the token, not a session cookie: sessions expire and are tied to a browser.
- Prefer `/api/resolve` over `dig` in monitoring — it reports the reason, not just the answer.
- `/api/flush` after a manual config edit is unnecessary; edits reload their indexes and the
  cache is keyed by name, not by config generation.
- Rate-limit your own polling. `/api/stats` walks every worker; once every 10 seconds is
  plenty for a dashboard.
