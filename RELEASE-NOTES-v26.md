# StellarDNS v26 — Sirius

v26 is a client-hardening release. The server API and the portable rules format are unchanged
from v25, so a v25 or newer server still serves rules to the client.

## Client fixes

- **DoT reconnect.** A timed-out query now drops the connection's in-flight slot and partial
  frame before the next attempt. A queued query that times out is removed without destroying a
  healthy exchange, and a TLS handshake that never completes resets the pool instead of leaving
  it permanently `connecting`.
- **Cache TTLs age.** Cached records are returned with their TTL reduced by the time spent in
  the cache, rather than at the TTL they had when inserted. Truncated responses are no longer
  cached as if they were complete answers.
- **Untrusted discovery data.** The loopback console builds discovered server rows with DOM
  nodes and event listeners, and escapes every server-provided bundle name, target and list URL.
  A malicious LAN server can no longer inject markup or an inline handler.
- **Safe Windows exit.** Closing the window when the tray could not be created now goes through
  the normal exit path instead of closing past DNS restoration. A failed `/api/dns/restore`
  aborts the exit; the core is not stopped while the adapter is still pointed at it.
- **IPv6 verification.** Windows takeover verifies `::1` after applying IPv6 DNS, restore
  verifies the saved IPv6 servers, and an explicit IPv6 listen address no longer attempts an
  IPv4 bind first.

## Verification

Run from `client/` unless noted:

| Check | Result |
|---|---|
| `npm run check` | syntax checks pass |
| `node test/dot.js` | 1 passed, 0 failed |
| `node test/e2e.js` | 28 passed, 0 failed |
| `node test/import.js` | 25 passed, 0 failed |
| `node test/smoke.js` (repo root) | 34 passed, 0 failed |

The e2e suite covers the new cache TTL aging assertion. The DoT test stubs `tls.connect` with a
socket that never completes its handshake and asserts that the next query opens a new
connection. The Windows DNS changes were compiled but not exercised against a real adapter.

## Linux installer

```
stellardns-install.sh
size    393,246 bytes
sha256  59268ca45651b42abfb67907a3190145398293cbca7e785919458b272ec518dd
build   20261115-234749
payload b6130c34a60477d23f44eaf027c8a8dc3d880915759d0cbaaae8ea452bd6b30e
```

Built with `install/build.sh` from the v26 tree. `sh stellardns-install.sh --version` reports
`stellardns 26.0.0 (build 20261115-234749)`, and `--check` verifies the payload checksum. The
extracted payload contains 87 files, with both `package.json` files and `APP_VERSION` at 26.0.0,
a byte-identical `public/index.html`, and no Windows MSI/`dist`/`bin` artifacts. The installer
was not run to completion (it requires a Linux host and root); only its self-check and payload
extraction were performed.

## Windows artifact

```
client/windows/dist/StellarDNS-26.0.0-x64.msi
size    85,958,545 bytes
sha256  43B936ABE4564895732808A79324FABB53413841FB827199E7522B35470D59E5
```

Built with `publish.ps1 -Runtime win-x64` and `build-msi.ps1 -Runtime win-x64`. Administrative
extract confirms the MSI payload is `core` 26.0.0, contains the v26 user agent and UI escaping
helper, and carries `core\node.exe` (85.7 MB). The MSI was not installed or launched in this
pass; the installed UI, tray and DNS flows were not re-tested. The ARM64 MSI was not rebuilt.

The MSI is unsigned and still triggers the usual SmartScreen prompt. No service is installed
and the installer itself does not change DNS.
