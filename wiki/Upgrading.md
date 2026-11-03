# Upgrading

The installer is the updater. There is no separate upgrade command, no migration step, and no
package manager involved.

## The whole procedure

```sh
sha256sum stellardns-install.sh
sudo sh ./stellardns-install.sh --check
sudo sh ./stellardns-install.sh
```

Three commands, one of which changes nothing. The `--check` run verifies the embedded payload
before you commit to touching the live resolver, which matters on a device the whole house
depends on.

## What is preserved

| Path | Kept | Notes |
|---|---|---|
| `config.json` | Yes | Backed up to `config.json.pre-<version>` first |
| `data/` | Yes | Users, `.admin-password`, cache snapshot |
| TLS material | Yes | Regenerated only if missing |
| Query log files | Yes | Rotated by `log.keepFiles` |
| `server.js`, `public/` | Replaced | This is the upgrade |
| Unit file | Rewritten | Regenerated from `SD_DIR` and the detected init system |

Nothing outside `/opt/stellardns` (or your `SD_DIR`) and the unit file is touched.

## What the installer does, in order

1. Verifies the payload checksum — a truncated download aborts before anything changes.
2. Stops the service and waits for ports 53, 853 and 8443 to be released. A process still
   holding them would make the new code fail to bind, and that failure looks like a crash.
3. Saves `config.json.pre-<version>`.
4. Extracts the new tree over the old one, leaving config and data alone.
5. Runs `node --check server.js` on the new file. Broken code never becomes the running code.
6. Starts the service.
7. Calls `GET /api/version` and prints the version it got back.

Step 7 is the one people skip when they upgrade by hand, and it's the one that catches the
common failure: the file on disk is new, the process is old, and everything *looks* updated.

## Verifying the upgrade

```sh
curl -s http://127.0.0.1:5380/api/version
```

```json
{"name":"stellardns","version":"24.1.0","node":"v20.x","pid":1234,
 "uptimeSec":3,"server":{"bytes":96123,"sha256_16":"..."}}
```

Check three things:

- `version` is what you installed.
- `uptimeSec` is seconds, not days. A long uptime means the restart didn't happen.
- `sha256_16` changed from before. This hashes the `server.js` actually loaded in memory.

That last field is the answer to "did the upgrade take?" when everything else is ambiguous.

## If it goes wrong

The previous config is right there:

```sh
sudo systemctl stop stellardns
sudo cp /opt/stellardns/config.json.pre-24.0.0 /opt/stellardns/config.json
sudo systemctl start stellardns
```

To go back to the previous *code*, re-run the older installer file — it's a self-contained
snapshot, so downgrading is the same operation as upgrading. Keep the previous installer
around for a release or two; it costs a few hundred kilobytes and it's the only rollback you
need.

## After upgrading across a major version

New keys take their defaults when absent, so an old `config.json` keeps working. To see what
the new version is actually running with, compare against `config.example.json` in the repo, or
just read the Config panel — it shows effective values, not the file.

Keys added in v24 that won't appear in an older config until you add them:

```json
{
  "hedge": true,
  "hedgeDelayMs": 60,
  "internalTtlCap": 30,
  "internalServeStale": false,
  "sinkholeIP": "",
  "sinkholeIPv6": ""
}
```

They default correctly without being present. Adding them makes the values explicit and
greppable, which is worth doing on a resolver you'll come back to in six months.

## Multi-worker note

With more than one worker, config writes go through the primary. An upgrade restarts all of
them; there's no rolling restart, because the cache is per-worker and a half-upgraded fleet
would answer from two code paths at once. A few seconds of SERVFAIL during restart is expected
if a client asks at exactly the wrong moment — the installer's port wait is what keeps that
window to the minimum.
