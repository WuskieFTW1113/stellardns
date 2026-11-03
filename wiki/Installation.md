# Installation

## Requirements

| | |
|---|---|
| OS | Debian, Ubuntu, or Alpine — bare metal, VM, or LXC |
| Init | systemd or OpenRC (detected at install time) |
| Privileges | root — it binds port 53 |
| Node | 18 or newer; the installer installs it via the distro, with NodeSource as a fallback |
| Disk | ~40 MB, plus whatever the cache snapshot grows to |

No Docker requirement, no database, no external service.

## The single-file installer

The release ships one file that both installs and upgrades. Download it, check it, run it:

```sh
sha256sum stellardns-install.sh
sudo sh ./stellardns-install.sh --check     # verifies the embedded payload only
sudo sh ./stellardns-install.sh             # installs or upgrades
```

`--check` matters because the application is embedded in the script as a base64 tarball. A
truncated download is a real failure mode, and the check catches it before anything on disk is
touched. The installer verifies the same checksum again on the way in, so `--check` is a
convenience, not the only guard.

### Options

| Flag | Effect |
|---|---|
| *(none)* | Install or upgrade, prompting for the admin password and optional LANCache import |
| `--check` | Verify this file's payload and exit; changes nothing |
| `--version` | Print version and build stamp, exit |
| `--help` | Print the header comment block |
| `--yes`, `-y` | No prompts; environment variables win |

### Environment

| Variable | Default | Purpose |
|---|---|---|
| `SD_DIR` | `/opt/stellardns` | Install prefix |
| `SD_WEB_PORT` | `5380` | Console port |
| `SD_ADMIN_PASS` | *(generated)* | Admin password to set |
| `SD_CACHE_IP` | *(none)* | LANCache IP; imports the uklans game CDN category |
| `SD_YES` | `0` | Same as `--yes` |

Non-interactive install, fully specified:

```sh
sudo SD_ADMIN_PASS='choose-something-long' SD_CACHE_IP=192.168.9.20 SD_YES=1 \
  sh ./stellardns-install.sh
```

If you omit `SD_ADMIN_PASS`, a password is generated and written to
`/opt/stellardns/data/.admin-password` with mode 600. It is not printed to stdout, so it does
not end up in your shell history or in a CI log.

## What the installer actually does

In order, and it stops at the first failure:

1. **Verifies the payload.** Checksum before extraction, so a corrupt file can never leave a
   half-upgraded resolver.
2. **Detects the service manager.** `/run/systemd/system` is the test — not the presence of
   `systemctl`, which exists in containers that don't run it.
3. **Waits for the ports to be released.** An existing instance has to let go of 53, 853 and
   8443 before the new code can bind them.
4. **Preserves state.** `config.json` is backed up to `config.json.pre-<version>`; `data/`
   (users, password, cache snapshot) and the generated TLS material are left alone.
5. **Syntax-checks the new server.** `node --check server.js` before it is allowed to become
   the running program.
6. **Installs and starts.** Writes the unit, enables it, restarts it.
7. **Probes the running process.** `GET /api/version` and prints the version it got back.
   That closes the gap between "the file on disk is new" and "the process holding port 53 is
   new", which are not the same thing after a failed restart.

The whole run is safe to repeat. Re-running against a live install is the supported upgrade
path — see [Upgrading](Upgrading).

## From source

For development, or if you want to read the code you are about to run:

```sh
git clone https://github.com/WuskieFTW1113/stellardns.git
cd stellardns
npm ci
sudo sh ./install.sh
```

`install.sh` in the repo does the same job from the working tree: it copies the tree to
`$SD_DIR`, seeds `config.json` from `config.example.json` on a fresh install, and leaves an
existing config alone on an upgrade.

To run it in the foreground without installing:

```sh
cp config.example.json config.json
sudo env STELLARDNS_CONFIG="$PWD/config.json" STELLARDNS_DATA="$PWD/data" node server.js
```

`STELLARDNS_CONFIG` and `STELLARDNS_DATA` override the default paths, which is also how the
test suites isolate themselves. No root is needed if you change `dns.port` and `dohPort` to
unprivileged values.

## Verify

```sh
systemctl status stellardns          # or: rc-service stellardns status
curl -s http://127.0.0.1:5380/api/version
dig @127.0.0.1 example.com A +short
```

`/api/version` reports the version, the PID, the uptime, and a short hash of the `server.js`
actually loaded into memory. The hash is the useful part: it distinguishes a restart that
worked from one that silently didn't.

Then open `http://<host>:5380` and sign in. See [Quick Start](Quick-Start) for the first-run
walkthrough.

## Notes

- **No uninstall flag.** Stop the service (`systemctl disable --now stellardns`) and delete
  `$SD_DIR` if you want it gone; nothing is installed outside that directory and the unit file.
- **Port 53 conflict.** Almost always `systemd-resolved` on Ubuntu. See
  [Troubleshooting](Troubleshooting#port-53-is-already-in-use).
- **LXC and VMs** have their own page: [Deployment](Deployment).
