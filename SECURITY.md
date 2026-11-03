# Security policy

## Reporting

Do not open a public issue for a vulnerability. Use GitHub's **Report a vulnerability**
(Security → Advisories) on this repository, or email the maintainer listed in `package.json`.

Please include the version (`curl -s http://127.0.0.1:5380/api/version`), the deployment
shape (bare metal, VM, LXC), and whether the console is exposed beyond the LAN.

Expect an acknowledgement within a few days. There is no bug bounty.

## What counts

| In scope | Examples |
|---|---|
| Resolver | Cache poisoning, a path that bypasses an internal-zone or blocklist decision, DNS rebinding past `rebindingProtection` |
| Console & API | Auth bypass, CSRF on a state-changing endpoint, privilege escalation between users, path traversal in a served asset |
| Storage | Reading or writing outside `data/`, config rollback that restores an attacker-controlled file |
| Transport | DoH/DoT handling flaws, certificate verification bypass on an encrypted upstream |
| Installer | Command injection through an environment variable, checksum bypass, writing a world-readable secret |

## What does not

- **The block page and the sinkhole stub are not an interception proxy.** They answer HTTP
  on port 80 for blocked names. Traffic sent to them is not decrypted, logged or forwarded,
  and no TLS certificate is ever served. A finding that amounts to "the stub accepts a
  connection for a blocked name" is the documented behaviour.
- **A client that uses its own DoH/DoT server** is outside the resolver's control by design.
- **Blocklist contents.** A domain wrongly listed upstream is a blocklist issue, not a
  vulnerability here; report it to the list and use the allowlist.
- Findings that require an attacker who already has local root, or physical access to the host.

## Supported versions

Security fixes land on the latest release line. Older majors are not patched.

| Version | Supported |
|---|---|
| 24.x | yes |
| ≤ 23.x | no |

## Hardening a deployment

The console is unauthenticated only until first-run setup completes. Beyond that:

- Keep `config.json` and `data/` at `0600` / `0700` — they hold the API token, the scrypt
  hashes and the generated admin password.
- Do not publish port 5380 to the internet. If you need remote access, put it behind a VPN
  or an authenticating reverse proxy; the session cookie is `SameSite=Lax` and assumes a
  trusted origin.
- Set a real admin password (`SD_ADMIN_PASS`) instead of keeping the generated one.
- Use DoH or DoT for upstreams on any network you do not control.
