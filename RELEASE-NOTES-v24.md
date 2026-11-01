# StellarDNS v24

Fast on every query, correct on internal names, quiet under ad-block detection — and the
installer is now an updater.

## Faster resolution

- **Persistent upstream sockets.** A cache miss no longer creates and destroys a UDP socket.
  One long-lived socket per address family is shared by all in-flight queries, replies matched
  on (address, port, DNS id). Four syscalls and two allocations removed from every miss.
- **Hedged upstreams.** `hedge` (on by default) starts the next forwarder if the first has been
  silent for `hedgeDelayMs` (60), and the first usable answer wins. A forwarder that is alive
  but slow no longer adds its full latency to every query. `race: true` keeps its old meaning —
  hedge with zero delay.
- **Encrypted upstreams are warmed at boot and every 60 s.** A cold DoH forwarder that answers in
  ~260 ms answers in ~30 ms once its connection is established; that gap was most of "DNS feels
  slow" after a restart or during quiet periods.
- **Allocation-free hot path.** Eviction walks the iterator instead of materialising every cache
  key; blocklist matching builds no closure per query; internal zones use a pre-normalised list
  instead of calling the normaliser per zone per query.

Measured by the included simulator over 1,202 queries: **p95 11.4 ms on cache hits, p95 24.7 ms
on misses, 86.2% hit rate, zero errors**; 5,195 q/s on a single worker at 40-way concurrency.

## Internal names no longer rename your devices

The "John's iPhone" → "John's iPhone (192)" rename is a Bonjour/mDNS conflict: when a device
reconnects it gets a new address, re-announces its name, and if the resolver still hands out the
*old* address with a long TTL, the other hosts conclude the name is taken and the device suffixes
it. Two fixes, both root-cause:

- Answers for internal and private names are clamped to `internalTtlCap` (30 s) — at the cache
  **and** on the wire, since a client that receives an hour-long TTL keeps its own copy for an
  hour no matter what this resolver does. `internalServeStale` is off, so an expired internal
  record is refetched rather than served stale.
- Duplicate resource records are removed from answers. mDNS clients read a repeated A record as
  two conflicting answers and rename themselves even when the address never changed.

The resolver's own `<hostname>.<internalZone>` record is re-upserted when its address changes and
the cache is cleared, so it cannot advertise a stale address either.

## A sinkhole that does not announce itself

- **Zero configuration.** The block address is the resolver's own LAN address, discovered from
  the default route (CGNAT and virtual interfaces are skipped) and re-probed every 60 s, so a
  DHCP move does not silently break blocking.
- **Responses shaped like the request.** The stub listener on port 80 returns what was asked for:
  a real, decodable 1×1 GIF or PNG for image beacons, JavaScript for `.js`, CSS, JSON for XHR,
  and 204 for media — instead of one HTML page for everything, which is a one-line detector.
  Credentialed CORS requests are echoed correctly.

This reduces simple "did the DNS fail?" detection. It does not defeat HTTPS interception or
certificate pinning, script-level ad verification, first-party ad delivery, or ad-block
detection that runs entirely in the page — no DNS-layer tool can.

## Console

Redesigned: graphite and vermilion, uppercase monospace, hairline metric strip, numbered panels
and nav rail, area-and-grid QPS chart with a peak readout, live q/s and cache hit rate, visible
focus rings, reduced-motion support.

- **Resolve a name** tool — resolves through the exact path a client takes (local records, zone
  forwarding, rewrites, blocklists, cache) and returns rcode, timing and answers. Diagnostic
  lookups bypass the query log so they do not skew analytics.
- Transport column in the query log.

## API

- `GET /api/resolve?name=…&type=…` — full-path resolution with timing.
- DoH **JSON** form: `/dns-query?name=example.com&type=A`. RFC 8484 wire format remains the
  default.
- `GET /api/stats` now reports `qps` (sampled once a second, summed across workers) and
  `hitRate`.
- `GET /api/version` — version, PID and build stamp, for confirming a restart actually happened.

## Security

- The generated admin password is written to `data/.admin-password` (mode 600) instead of stdout,
  where journald kept it forever.
- The installer sets passwords through the API using `node` and an environment variable: no shell
  interpolation into JSON (a quote or backslash used to corrupt it) and no secret visible in `ps`.

## The installer is an updater

Re-running `stellardns-install.sh` upgrades in place. It verifies the payload checksum before
touching the system, waits for the listener to release before replacing files, keeps
`config.json`, `data/`, users and TLS material, saves `config.json.pre-<version>`, syntax-checks
the new `server.js` before restarting, and prints the console URL and API token. `--check`
verifies a download without installing anything; `--version` reports what is embedded.

## Upgrading

```sh
sudo sh stellardns-install.sh
```

Then hard-refresh the console (Ctrl-Shift-R / Cmd-Shift-R). Your existing configuration is
preserved; new keys take their defaults.

## Compatibility notes

- `hedge`, `hedgeDelayMs`, `internalTtlCap` and `internalServeStale` are new and defaulted, so an
  existing `config.json` keeps working unchanged.
- Clamping internal TTLs to 30 s means slightly more upstream traffic for local names and a
  shorter window where a just-changed record is stale anywhere. That is the trade for names that
  stay correct across reconnects.
- If a device was already renamed, this release prevents it from recurring; the existing suffix
  must be removed once on the device or at the router.