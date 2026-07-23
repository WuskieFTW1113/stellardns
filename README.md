# StellarDNS v19 — Install

A fast, gaming-oriented DNS server with a web console.

- LANCache rewrites with per-launcher on/off toggles
- AdGuard/hosts blocklists, validated before applying, with rollback
- DNS-over-TLS and DNS-over-HTTPS — inbound *and* outbound (encrypted upstreams)
- Internal zones, conditional forwarding, Active Directory support
- Per-device / per-VLAN policy, client ACLs, rate limiting
- Multi-core, IPv4 + IPv6, Prometheus metrics, query analytics

Roughly 28,000 queries/sec per core with a full ruleset loaded; cache hits in ~50 µs.
See CHANGELOG.md for what changed since the alpha.

Runs on **Debian, Ubuntu, or Alpine** — bare metal, a VM, or an LXC container.

## Install

Download `stellardns-install.sh`, then:

```sh
sudo sh stellardns-install.sh
```

It asks two quick questions (admin password, and your LANCache IP if you have one),
installs everything, starts the service, and prints the console URL and login.

That's it. Open the console at `http://<host>:5380` and sign in.

## Non-interactive install

For automation, set any of these environment variables and pass `-E` to sudo:

```sh
SD_ADMIN_PASS='choose-a-password' \
SD_CACHE_IP='10.0.0.5' \
SD_YES=1 \
sudo -E sh stellardns-install.sh
```

- `SD_ADMIN_PASS` — admin password for the console (omit to auto-generate)
- `SD_CACHE_IP` — LANCache server IP; imports the full game-CDN list pointed at it
- `SD_YES=1` — accept defaults, no prompts

## After install

1. Open `http://<host>:5380` and sign in as `admin`.
2. In **Rewrites & launchers**, set your cache IP (or import the uklans list).
3. Point your router's DHCP DNS — or each device — at this host's IP.
4. (Optional) In **Blocking**, paste a blocklist URL (e.g. a hagezi list).

## Upgrading

Run the newer installer the same way. It detects the existing install and upgrades
in place — your config, users, cache, and rewrites are preserved. No prompts on upgrade.

Upgrading from an alpha also repairs known damage: a corrupted `config.json` is restored
from backup, an oversized cache snapshot is removed, a stale `cache.maxEntries` is
lowered, and `dns.host6: ""` (which silently disabled IPv6) is migrated to `"::"`.

## Endpoints

| Service | Port |
|---|---|
| DNS (UDP/TCP) | 53 |
| DNS-over-TLS | 853 |
| DNS-over-HTTPS | 8443 (`/dns-query`) |
| Web console | 5380 |

## Managing the service

```sh
systemctl status stellardns      # Debian/Ubuntu
rc-service stellardns status     # Alpine
```

Config lives at `/opt/stellardns/config.json`. High-availability (two-node failover)
setup is in `/opt/stellardns/ha/`.

## Requirements

- Root access to install
- Node.js (installed automatically if missing)
- A free port 53 (the installer disables `systemd-resolved`'s stub listener for you)
