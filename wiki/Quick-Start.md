# Quick Start

From "it installed" to "the whole house is using it". Ten minutes, mostly waiting for DHCP
leases to renew.

## 1. Confirm it answers

```sh
dig @127.0.0.1 example.com A +short
dig @127.0.0.1 example.com A +stats | grep 'Query time'
```

The second query should be much faster than the first — that's the cache. If the first one
fails, stop here and read [Troubleshooting](Troubleshooting).

## 2. Sign in to the console

Open `http://<host>:5380`. The username is `admin`. The password is either the one you passed
as `SD_ADMIN_PASS` or the generated one:

```sh
sudo cat /opt/stellardns/data/.admin-password
```

Change it from the console once you're in. The session cookie is `HttpOnly` and
`SameSite=Strict`; the password itself is stored as a hash, never in `config.json`.

If you'd rather use a token than a session — scripts, dashboards, Home Assistant — see
[Console and API](Console-and-API).

## 3. Point one device at it first

Don't change the router yet. Set a single laptop or phone to use `<host>` as its DNS server
and use it for a few minutes. This is the step where you find out whether the resolver is
reachable from the LAN at all, without taking the whole house offline to learn it.

On Linux: `resolvectl dns <iface> <host>`.
On macOS: System Settings → Network → Details → DNS.
On Windows: adapter properties → IPv4 → preferred DNS.

## 4. Point the router at it

In the router's DHCP settings, hand out `<host>` as the DNS server. Leave the secondary empty
or point it at the same host — a public secondary is worse than nothing here, because clients
will silently fall back to it and bypass your blocking entirely.

Two things worth doing while you're in there:

- **Give the resolver a static address or a DHCP reservation.** Every client now depends on
  this IP; if it moves, the network loses DNS.
- **Keep the router's own resolver off your LAN interface** if it offers one. A router
  advertising itself as DNS will happily answer from its own cache and hide the new resolver.

## 5. Check an internal name

From a device on the LAN:

```sh
dig @<host> my-nas.local A +short
dig @<host> my-nas.local A +noall +answer | awk '{print $2}'
```

The TTL should be 30 or less. That clamp is deliberate: it's what stops a renamed Bonjour
device from being stuck under its old name. See
[Internal Names and Bonjour](Internal-Names-and-Bonjour).

If internal names don't resolve at all, the resolver doesn't know which zone to ask. Look at
`internalZones` and `conditionalForwarders` in [Configuration](Configuration), or use the
console's forwarding panel, which can detect the gateway for you.

## 6. Turn on blocking, if you want it

In the console's Blocking tab, paste blocklist URLs, one per line, and apply. The default
response mode is `nxdomain`; the interesting one is `sinkhole`, which answers from a local
address instead of failing. Read [Ad Blocking and the Sinkhole](Ad-Blocking-and-Sinkhole)
before choosing — the modes differ in what your clients see and what the resolver has to be
able to reach.

## Where to go next

- Want more speed? The caching and hedging knobs are in [Configuration](Configuration);
  the defaults are already tuned.
- Want TLS on the wire? [Deployment](Deployment) covers certificates and the DoT/DoH ports.
- Something behaving oddly? [Troubleshooting](Troubleshooting) is organized by symptom.
