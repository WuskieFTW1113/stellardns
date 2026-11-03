# StellarDNS

A local DNS resolver for a home or small-office network. It caches aggressively, hedges
upstreams so a slow resolver never holds up a page load, answers Bonjour and other internal
names without caching them until they rot, and blocks ads with a sinkhole that behaves like a
normal answer instead of a network-level block page.

Single file install. One command to upgrade. Config and users survive it.

```sh
sudo sh stellardns-install.sh
```

## At a glance

| | |
|---|---|
| DNS | `:53` UDP + TCP |
| DNS-over-TLS | `:853` |
| DNS-over-HTTPS | `:8443` — `/dns-query`, wire or `?name=` JSON |
| Console | `http://<host>:5380` |
| Block page | `:8053` (only in `blockpage` mode) |
| Sinkhole stub | `:80` (only in `sinkhole` mode) |
| Install root | `/opt/stellardns` |
| Config | `/opt/stellardns/config.json` |
| Runtime data | `/opt/stellardns/data/` — users, admin password, cache snapshot |

## Start here

**Installing for the first time.** [Installation](Installation) covers requirements, the
single-file installer, and the from-source route. [Quick Start](Quick-Start) takes you from
"it's running" to "my phone is using it" in six steps.

**Tuning it.** [Configuration](Configuration) is the full key reference, including the ones
the example file doesn't mention. [How Resolution Works](How-Resolution-Works) explains the
order of checks, which is what makes the rest of the settings make sense.

**Something is wrong.** [Troubleshooting](Troubleshooting) starts from symptoms, not from
components. [Testing](Testing) has the unprivileged suites you can run to find out whether the
problem is the server or the network around it.

## The three things people come here for

**Speed.** A query that misses the cache is sent to the first upstream; if that upstream is
silent for 60 ms, the same question goes to the second one in parallel and whichever answers
first wins. That removes the tail latency of a single slow resolver without the cost of asking
everyone every time. See [How Resolution Works](How-Resolution-Works).

**Internal names that behave.** Bonjour, `.local`, Active Directory and router-assigned names
are answered from the network and never served stale. The TTL is clamped to 30 seconds on the
way out, so when "John's iPhone" reconnects as a different device, it becomes a new name
instead of `John's iPhone (192)`. See [Internal Names and Bonjour](Internal-Names-and-Bonjour).

**Blocking that doesn't announce itself.** Blocked names get an answer shaped like a real one,
from an address the resolver discovered on your own network — so a client can't tell it is
behind a blocker just by looking at the response. See
[Ad Blocking and the Sinkhole](Ad-Blocking-and-Sinkhole).

## Pages

- [Installation](Installation) — requirements, installer, flags, from source
- [Quick Start](Quick-Start) — running to actually in use
- [Configuration](Configuration) — every key, with defaults
- [How Resolution Works](How-Resolution-Works) — the query path end to end
- [Internal Names and Bonjour](Internal-Names-and-Bonjour) — the duplicate-hostname problem
- [Ad Blocking and the Sinkhole](Ad-Blocking-and-Sinkhole) — modes, discovery, limits
- [Console and API](Console-and-API) — auth, endpoints, Prometheus, backups
- [Deployment](Deployment) — LXC, VM, router wiring, certificates
- [Upgrading](Upgrading) — what the installer preserves and how to verify
- [Troubleshooting](Troubleshooting) — symptom-first
- [Testing](Testing) — the four suites and what they prove
