# StellarDNS v24.1 — Spaceland

A stealth sinkhole that stops looking like a filter, and the release is packaged for GitHub
properly: a security policy, issue and PR templates, release notes, and CI that runs the real
suites instead of booting the server once.

## The problem with a "stealth" sinkhole

v24 discovered a LAN address and answered blocked names with it, which defeats the cheapest
detector there is — "did DNS fail?". It left every other constant in place:

- one address for every blocked name,
- one TTL (60) for every blocked name,
- a port-80 stub that answered **any** Host header with a perfectly shaped ad beacon,
- NXDOMAIN for CNAME-cloaked hits while ordinary hits got an address,
- EDE 15/17 on the paths that had to return NXDOMAIN.

A filter is recognizable by its constants. Ten blocked domains that answer identically are ten
blocked domains you can find with one query per name and a `Set`. Point any name at the
resolver, request `/collect`, and an open stub confirms a sinkhole exists where nothing should
be listening at all.

## What changed

**Answers now vary the way real ones do.**

- **Per-subnet address.** A blocked A answer uses this host's own address *on the client's
  subnet*, chosen from a 30-second-cached interface scan. A box serving two VLANs gives each
  one an address it can actually route to — a dead address is a failed connection, which is
  the symptom blocking is supposed to hide. `sinkholeIP` still overrides everything.
- **Per-name TTL.** Derived from the name with FNV-1a, mapped into 300–3600 s. Deterministic,
  so asking twice proves nothing; varied, so asking ten domains shows ten zones. Measured on
  six blocked names: `600, 2400, 3600, 3420, 1080, 1860`.
- **NODATA with an SOA.** A blocked AAAA with no `sinkholeIPv6` returns `NOERROR`, no answers,
  and the synthetic zone SOA a recursor would have cached the negative under. NXDOMAIN would
  claim the domain does not exist; NODATA is what a zone without AAAA actually returns, and
  it is true.
- **No Extended DNS Errors.** EDE 15/17 is a machine-readable "I filtered this". In stealth
  mode nothing on a block path attaches one — including `launcher-off`, `blockAll` and
  rebinding, which still have to answer NXDOMAIN for their own reasons.

**Every block path agrees.** `blockAnswer()` is now the only place a blocked name is answered,
shared by the qname hit and the CNAME-cloak hit. Previously a cloaked tracker NXDOMAINed while
a plain ad got an address, which made the best-hidden blocks the easiest to detect.

**The block-page IP can no longer leak.** `sinkholeAddress() || config.blockPageIP` meant a
host that had once used `blockpage` mode could hand out the address of the page that says
"Blocked by StellarDNS". The fallback is gone; the engine returns NODATA instead.

**The stub is not an oracle.** It answers only names that are on a blocklist (or are in the
recent-blocked reason map) and returns a plain `404` otherwise — like any host that does not
run that service.

**Console.** The Block response panel shows what the resolver actually decided: mode, detected
addresses, and whether the port-80 stub is up. `/api/stats` exposes
`stealth: { mode, address, addresses[], stub80, fixed }`.

## Verification

```
test/sinkhole.js    11 passed    (was 7)
test/smoke.js       16 passed
test/fastpath.js     3 passed
```

New checks: a non-blocked Host gets `404` from the stub, a blocked AAAA without a v6 sinkhole
is NODATA rather than NXDOMAIN, TTLs differ across blocked names, and the TTL for one name is
stable across queries.

## Packaging

- `SECURITY.md` — scope, non-goals (the stub is not a proxy), supported versions, hardening.
- Issue forms for bugs and feature requests, a PR template, and `contact_links` that route
  vulnerabilities to a private advisory.
- CI now runs `smoke`, `fastpath` and `sinkhole` on Node 18, 20 and 22, not just a boot check.
- `README` rewritten around v24.1 with the honest ceiling stated where the feature is sold.

## Upgrading

```sh
sudo sh stellardns-install.sh
```

Re-running the installer updates in place: `config.json`, `data/`, users and TLS material are
preserved, `config.json.pre-24.0.0` is kept for rollback, and the new `server.js` is
syntax-checked before the service restarts. Hard-refresh the console afterwards
(Ctrl-Shift-R / Cmd-Shift-R).

No config changes are required. `sinkholeIP` and `sinkholeIPv6` keep working; leaving them
empty is now the better choice, because the address is chosen per client subnet.

## Compatibility notes

- TTLs for blocked answers are no longer 60. A client that used to re-ask every minute will
  cache a blocked name for up to an hour, and unblocking takes effect after that window
  unless the client cache is flushed. Lower it if you unblock often by setting a TTL on the
  list entry, or keep `blockedResponse: nxdomain` where instant reversion matters more.
- The stub now returns `404` for names that are not blocked. If something depended on the
  stub answering arbitrary names, it will stop working — that is the point.
- `blockpage` mode is unchanged: same address, same TTL, same explanatory page. Stealth and
  explanation are different goals; pick one per deployment.

## The honest ceiling, again

This defeats "did DNS fail?" and now "do all blocked answers look the same?". It does not
touch TLS certificates, certificate pinning, a client running its own DoH/DoT, first-party ad
delivery, or detection that runs entirely inside the page. No DNS-layer tool can, and a
network that cannot be debugged is worse than an ad that loads.
