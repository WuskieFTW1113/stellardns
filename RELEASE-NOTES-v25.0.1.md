# StellarDNS v25.0.1 — Polaris

A patch release, and a small one: a single resolver bug that made Plex look broken.

## Plex clients could not reach the server

Plex publishes its LAN address as a public name — `192-168-4-21.<hash>.plex.direct` —
whose entire purpose is to answer with a private IP. Rebinding protection exists to
refuse exactly that answer, so every plex.direct name pointing at a LAN address came back
NXDOMAIN. The server was healthy (`/identity` in under a millisecond, library queries in
tens of milliseconds, metadata fetches returning 200) and clients resolving it through
plex.direct reported it unreachable. `plex.tv` resolved and connected fine the whole
time, which is what made it look like a network or firewall problem.

`plex.direct` is now exempt from the rebinding policy, the same way your own rewrites and
local records already were. Public plex.direct answers were never affected and pass
through untouched; a random public name resolving to 10.x is still blocked. There is no
config key to set, no migration and no change to restart behaviour.

If you had already worked around this by adding `plex.direct` to `rebindingAllow`, that
entry is now redundant — leaving it in place is harmless.

## Upgrading

Console → Updates, or re-run the installer; config, users, cache, logs and TLS material
are preserved.
