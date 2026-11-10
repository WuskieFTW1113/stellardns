# Troubleshooting

Organized by symptom. Start with the one you're seeing.

## Port 53 is already in use

The installer fails at the bind step, or the service starts and immediately exits.

On Ubuntu and some Debian installs, `systemd-resolved` holds port 53:

```sh
sudo ss -lunp 'sport = :53'
```

```sh
# stop it holding the stub listener
sudo mkdir -p /etc/systemd/resolved.conf.d
printf '[Resolve]\nDNSStubListener=no\n' | sudo tee /etc/systemd/resolved.conf.d/stellardns.conf
sudo systemctl restart systemd-resolved
```

Then point the host itself at the resolver so local lookups still work:

```sh
printf 'nameserver 127.0.0.1\n' | sudo tee /etc/resolv.conf
```

If it's `dnsmasq` or Pi-hole, stop and disable that service — two resolvers on one port will
fight forever. Docker's embedded DNS can also hold 53 on the host; run the container with
`--network host` and the host resolver disabled, or don't run it in Docker.

## The console won't load

```sh
systemctl status stellardns
journalctl -u stellardns -n 50 --no-pager
ss -ltnp 'sport = :5380'
```

- **Connection refused** — the process isn't running. Read the journal; it says why.
- **Loads but login fails** — wrong password. It's in `data/.admin-password` unless you set
  `SD_ADMIN_PASS`. If you've lost it, stop the service, move `data/users.json` aside, and the
  next start regenerates an admin user and a password file.
- **Reachable from the host, not the LAN** — `web.host` is `127.0.0.1`, or a firewall is
  blocking 5380.
- **Page loads, panels are empty** — `401` from the API. The session cookie didn't stick; check
  that you're not on a different hostname than the one you logged in on.

## Everything returns SERVFAIL

SERVFAIL means the resolver tried and failed, which is different from NXDOMAIN (tried and the
name doesn't exist).

```sh
curl -s http://127.0.0.1:5380/api/stats | grep -o '"upstreams":\[[^]]*\]'
```

Look at `circuitOpen` and `failed` per upstream. If every circuit is open, the resolver can't
reach the internet — check the host's own connectivity and default route before touching DNS
config. A resolver that can't reach upstream is indistinguishable from a broken network.

If only one upstream is failing, that's fine: `circuitOpen` is the circuit breaker doing its
job, and queries go to the healthy one. It closes again after `probeIntervalMs` once the
upstream recovers.

## Internal names are slow, wrong, or absent

| Symptom | Likely cause |
|---|---|
| Returns NXDOMAIN instantly | Zone is in `internalZones` but nothing answers it, and `internalFallback` is off or wrong |
| Takes ~700 ms | `internalTimeoutMs` is being hit — the fallback address is unreachable |
| Name gains a suffix each reconnect | Zone isn't actually internal; lookups are going upstream |
| Old name keeps resolving | A client cached it, or `internalServeStale` got turned back on |

```sh
curl -s http://127.0.0.1:5380/api/forwarders
```

That returns the configured forwarders, the active fallback addresses, and the detected
gateway. If `detectedGateway` is wrong, the host has an unusual routing table — set
`internalFallback` to an explicit address.

`GET /api/resolve?name=my-nas.lan` tells you how the name was handled, including how long it
took. Full detail in [Internal Names and Bonjour](Internal-Names-and-Bonjour).

## Blocking stopped working

In order of likelihood:

1. **The client uses its own secure DNS.** Chrome, Firefox, iOS and Android can all use DoH
   directly, bypassing you entirely. Turn off "secure DNS" / "private DNS" per client, or block
   DoH provider addresses at the firewall.
2. **A public secondary got handed out.** Check what DHCP actually sends. A client that fails
   over to `8.8.8.8` isn't blocked and never will be.
3. **The name isn't in the list.** Check directly:
   `GET /api/blocking/why?domain=example.com` returns the matched rule, or says allowlisted,
   paused, or no match.
4. **Blocking is paused.** `blockingPausedUntil` is in the stats output. The console shows it.
5. **The blocklist refresh failed.** `GET /api/blocklists` includes refresh metadata; a failed
   fetch keeps the previous list, so blocking should continue — but a list that never loaded
   leaves nothing to match.

## `config.json` is corrupt or was recovered

At boot the resolver validates the file. If it can't parse, it:

- recovers from `config.json.bak`;
- keeps the broken copy as `config.json.corrupt`;
- logs `[config] RECOVERED settings from config.json.bak`.

Check the journal for that line before assuming a setting took effect. Then diff what you have
against the backup:

```sh
ls -la /opt/stellardns/config.json*
sudo diff /opt/stellardns/config.json.bak /opt/stellardns/config.json
```

A trailing comma is the usual culprit. Restore from the console's backup endpoint if the
differences are extensive.

## TLS warnings or DoH clients refuse to connect

The certificate is self-signed and generated locally. Clients that validate certificates will
reject it — that's correct behaviour.

- Trust the certificate on your devices, or
- terminate TLS at a reverse proxy with a real certificate, or
- use plain DNS internally and DoH only where you control trust.

```sh
openssl s_client -connect <host>:853 -servername <host> </dev/null 2>/dev/null | openssl x509 -noout -subject -dates
```

If the date range is in the past, the certificate wasn't regenerated — check that `data/` is
writable and preserved.

## The upgrade "didn't happen"

The console looks the same as before. Usually it's the browser cache, which is why the console
is served with `Cache-Control: no-cache` — but a service worker or a proxy can still hold it.

```sh
curl -s http://127.0.0.1:5380/api/version
```

If `version` is new and `uptimeSec` is small, the server is new and the browser is stale: hard
reload. If `version` is old, the restart never happened — check the journal for a bind failure
and see [Upgrading](Upgrading#verifying-the-upgrade).

## The Updates view vanished after an upgrade

The console loads and everything else works, but the tab that performs updates is gone —
usually right after an update. Check what the server is actually serving:

```sh
curl -s http://127.0.0.1:5380/ | grep -c 'update/state'
```

`0` means the page contains no Updates code at all. The server itself will still report the
version you installed:

```sh
curl -s http://127.0.0.1:5380/api/version
```

**Cause.** Up to 25.0.1 the updater installed `public/index.html` from the release tag, and
the repository still held a pre-v25 console (73,120 bytes, no Updates view) while the v25
installer payload carried the real one (77,001 bytes). Applying the update wrote the older
page over the working one: the server was current and the UI was not.

**Fix.** The updater keeps a copy of what it replaced, so the previous console is still on
disk. As root:

```sh
ls -d /opt/stellardns/data/update/backup-*
cp /opt/stellardns/data/update/backup-25.0.0/public/index.html \
   /opt/stellardns/public/index.html
```

Reload the console — it is served `Cache-Control: no-cache`, so a normal reload is enough.
Then upgrade to 25.0.2 or later, or re-run that installer, which carries the correct
console. Before touching anything, `wc -c` on `/opt/stellardns/public/index.html` tells you
which one you have: about 77 KB is the v25 console, about 72-73 KB is the old one.

## High memory use

`cache.maxHeapMB` (512 MB default) bounds the cache, not the process. Node's heap plus
per-worker caches plus blocklists add up. The stats endpoint reports `heapMB`, `rssMB`,
`budgetMB` and `memEvictions`. If `memEvictions` climbs continuously, the budget is too small
for the traffic and you're paying in cache misses; raise it. If RSS grows while heap is flat,
that's the allocator holding freed pages, which is normal and not a leak.

## Getting help

If none of this fits, collect:

```sh
curl -s http://127.0.0.1:5380/api/version
curl -s -H "x-api-token: $TOKEN" http://127.0.0.1:5380/api/stats
journalctl -u stellardns -n 100 --no-pager
cat /opt/stellardns/config.json
```

and open an issue. Redact your API token and any internal hostnames you'd rather not publish.
