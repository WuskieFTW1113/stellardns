# StellarDNS v20

### Internal zones with a leading dot never matched

Entering a zone as `.internal` rather than `internal` — a natural way to type it, and how
several other DNS tools accept zone input — matched nothing, ever. `stellarad.internal` in
the same list worked, which made the bug look zone-specific rather than what it was.

The normalizer stripped only a *trailing* dot, so `.internal` stayed `.internal` and the
suffix check became `qname.endsWith('..internal')`, which cannot occur. The same incomplete
pattern existed in six places: internal zones, conditional-forwarder zones, local record
names, and the QNAME-minimization helper.

Fixed with a single `normZone()` used wherever a zone or domain config value is read,
stripping leading *and* trailing dots. Also applied when zones are saved, so an existing
`.internal` self-heals on the next edit.

### Forwarding loop guard was too broad

When a router forwards client queries to StellarDNS, every query arrives *sourced from the
router*. The internal-zone and PTR paths treated "the asker is one of my forwarders" as
"refuse immediately", so internal names failed for the whole network. Conditional-forwarder
zones kept working because that path only excluded the asker from its upstream list rather
than refusing outright — which is why a zone like `ad.example.internal` resolved while
`.internal` did not.

Both paths now do the precise thing: drop only the *asking* resolver from that query's
upstream list, and refuse only when nothing else remains to consult. Loop prevention is
unchanged — a query is never bounced back to its sender.

If your only internal fallback *is* the router, and the router forwards to StellarDNS,
nothing else remains to consult and internal names still cannot resolve. That is a topology
loop, not a bug; see **Internal zone topology** in the README.

### HA health checks could drop the VIP during a WAN outage

The keepalived health check queried a public name, and `dig` exits non-zero on timeout.
During an upstream outage the check failed on **every node at once**, so all instances
entered FAULT and the VIP disappeared — exactly when the resolvers were still perfectly able
to serve cache, LANCache rewrites and internal zones.

- Added `health.stellardns`: answered locally, never forwarded, never cached. `TXT` returns
  worker count, cache size and uptime.
- The health check now uses it, so it tests resolver liveness rather than internet
  reachability. Verified with dead upstreams: the health name answers in 8 ms while a public
  name times out.
- VRRP switched to **unicast peering**, avoiding the most common split-brain cause
  (switches or firewalls filtering multicast 224.0.0.18).
- Every failure mode is documented in `ha/keepalived.conf`, including the one a VIP cannot
  cover — both nodes down — and its mitigation (a second DHCP-supplied DNS server).

### Installer

`package.json` was not copied during an in-place upgrade, so `npm install` found nothing and
the failure was masked by `|| true`. Harmless while `node_modules` already existed, broken
the moment it did not. Now copied, and npm failures are surfaced instead of swallowed.

---

## Install

```sh
sudo sh stellardns-install.sh
```

Or from source:

```sh
git clone https://github.com/YOURNAME/stellardns.git
cd stellardns && sudo ./install.sh
```

Upgrading is in place — config, users, cache and rewrites are preserved. The installer also
repairs damage from older versions: a corrupted `config.json` is restored from backup, an
oversized cache snapshot is removed, a stale `cache.maxEntries` is lowered, and
`dns.host6: ""` is migrated to `"::"`.

After a UI change, hard-refresh the browser (Ctrl-Shift-R / Cmd-Shift-R).

**SHA256 of stellardns-install.sh payload:** see the installer header.
