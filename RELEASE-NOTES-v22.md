# StellarDNS v22

## Blocking compatibility

- Added the `sinkhole` blocking response mode. Configure `sinkholeIP` and optionally `sinkholeIPv6` to return a successful DNS answer for blocked A/AAAA queries. Other types and unconfigured address families return NOERROR/NODATA instead of NXDOMAIN.
- Added a local HTTP stub endpoint on `blockPagePort` (default 8053) for JSON/HTML success-shaped responses and CORS preflight handling. Route HTTP traffic to this port only where intended; HTTPS interception and local CA installation are not enabled.
- Added a “Why?” action in the query log and a diagnostic API endpoint explaining direct blocklist matches, allowlisting, and pause state.
- Added timed pause/resume for blocklist enforcement. The expiry timestamp is stored in config and survives restarts.
- Added one-click presets for HaGeZi Multi LIGHT/PRO, AdGuard DNS filter, and OISD small.

## Console and operations

- Added client IP display-name mappings for the query log.
- Added configuration backup export and validated restore endpoints with a download/upload workflow in Access & Users.
- Added a light/dark theme toggle, live queries-per-second chart, and client/domain/type/response query-log text filtering.
- Updated package metadata and changelog for v22.

## Compatibility notes

- Existing v21 settings remain valid; new configuration fields have defaults.
- Sinkhole mode is opt-in. It can reduce simple DNS-failure-based detection but does not guarantee that sites accept stub content as a real ad. HTTPS certificate pinning, first-party ad delivery, script checks, and application-specific validation remain outside DNS's control.
- Configuration backups can contain API tokens and network details. Store them securely.
