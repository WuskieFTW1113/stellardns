# StellarDNS v26.0.1 — Sirius patch

A server-only follow-up to v26.0.0. The Windows client is unchanged and remains 26.0.0.

## Opt-in client TTL floor

v26.0.0 aged cached answers to the lifetime left in the server's cache. A lookup that landed
near expiry could therefore return a 0/1-second TTL even though the server still had the answer.
Downloaders that resolve again for new connections can move to another CDN edge mid-transfer.

`cache.clientTtlFloor` is now available and **disabled by default**:

```json
"cache": {
  "clientTtlFloor": 0
}
```

Set it to a number of seconds (for example `30`) to return at least that TTL for fresh cache
hits. Stale answers keep their existing 30-second cap, so the stale-address protection is not
weakened. The setting is also accepted by `POST /api/settings`:

```sh
curl -X POST -H "x-api-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"cache":{"clientTtlFloor":30}}' \
  http://127.0.0.1:5380/api/settings
```

This floor has **not** been verified against a 2.5 Gbit Steam download. Keep it at `0` until a
controlled test shows that near-expiry TTLs are the cause; if enabling it does not restore the
download speed, leave it disabled.

## Verification

| Check | Result |
|---|---|
| `node --check server.js` | pass |
| `node test/fastpath.js` | 6 passed, 0 failed |
| `node test/smoke.js` | 34 passed, 0 failed |
| `node test/payload.js` | pass |

The fastpath suite includes both sides of the switch: a short TTL is unchanged at the default
`0`, the setting can be enabled through the settings API, and an enabled floor raises a
near-expiry answer to 30 seconds.

## Linux installer

```
stellardns-install.sh
size    390799 bytes
sha256  44da0edded1a190553ea8f4c751988a503a36061f6ead7cfe0e9f431dbdfa6f3
build   20261116-062445
payload ad3406e4187906f3f4ebc8ae5001fa236263ebb8c09cd3c7b9e0083ecb19dc08
```

Built from the v26.0.1 tree. `sh stellardns-install.sh --version` reports
`stellardns 26.0.1 (build 20261116-062445)`, and `--check` verifies the payload checksum. The
installer was not run to completion here; only its self-check and payload extraction were
performed.

## Windows artifact

The Windows client did not change in this server patch, so the release bundle includes the
existing, unchanged MSI:

```
StellarDNS-26.0.0-x64.msi
size    85,958,545 bytes
sha256  43B936ABE4564895732808A79324FABB53413841FB827199E7522B35470D59E5
```

The MSI is unsigned and still triggers the usual SmartScreen prompt. No service is installed
and the installer itself does not change DNS.
