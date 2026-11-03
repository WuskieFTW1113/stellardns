# Internal Names and Bonjour

The problem this page exists for:

> John's iPhone connects to the network and shows up as **John's iPhone**. It reconnects a day
> later and now every device on the network sees **John's iPhone (192)** — and two weeks after
> that, **(192) (192)**.

Nothing is broken. Every layer is doing exactly what it was told, and the interaction between
those layers is the bug.

## Where the suffix comes from

A device's hostname must be unique in a DNS zone. When a router or a Bonjour proxy registers a
name that already exists, the conventional fix is to make it unique by appending something —
often the last octet of its address. So the second registration becomes
`John's iPhone (192)`.

That should be temporary. It isn't, for three reasons that stack:

1. **The old record is still cached, with a long TTL.** A 24-hour TTL on a hostname that
   changes when the device sleeps means the network keeps believing the old name for a day.
2. **The client cached the old answer too.** Even if the resolver forgets instantly, the phone
   that looked up the name an hour ago still has it.
3. **The device offers both names.** Its mDNS advertisement and its DHCP hostname can drift
   apart, so two spellings of the same machine exist at once and both resolve.

## What StellarDNS does about it

Three mechanisms, each aimed at a different layer. None of them can reach into a client's
cache — that's why the third one matters most.

### 1. Internal names are never served stale

`internalServeStale: false` (`Configuration`, **not in example**). For names inside
`internalZones` and those answered by conditional forwarders, an expired entry is not used.
The query goes out, every time.

This is the opposite of the policy for public names, deliberately. A stale public A record is
a few milliseconds of saved latency; a stale internal record is a device that appears offline
or under the wrong name.

### 2. Internal TTLs are clamped on the wire

`internalTtlCap: 30`. Internal answers leave the resolver with a TTL of at most 30 seconds,
regardless of what the upstream or the local record says.

This is the only mechanism that affects the *client's* copy. A phone that cached
`John's iPhone` for 24 hours will hold it for 24 hours; the resolver can't help. A phone that
cached it for 30 seconds will ask again in 30 seconds and get the truth. The clamp converts a
day-long wrong answer into a half-minute one.

### 3. Duplicate answers are collapsed

`normalizeAnswers()` deduplicates records in a single response. A device registered under both
its Bonjour name and its DHCP name, or answered twice by two forwarders, produces one clean
record rather than a set the client has to choose from.

### Also relevant

- **`selfRecord: true`** makes the resolver answer its own hostname with its own address, so it
  appears in the network's device list like anything else.
- **`forwardLoopGuard`** stops an internal lookup from being forwarded back to the router that
  forwarded it here, which is how a rename can otherwise take 30 seconds to time out.

## Setting up the zones

You must tell the resolver which names are internal. It will not guess, and guessing is how a
`.local` lookup ends up at a public resolver.

```json
{
  "internalZones": ["lan", "local", "home.arpa"],
  "conditionalForwarders": [
    { "zone": "corp.example.com", "upstreams": [{ "address": "10.0.0.10", "port": 53 }] }
  ],
  "internalFallback": "auto",
  "internalTimeoutMs": 700
}
```

`internalFallback: "auto"` uses the detected default gateway to answer internal names not
covered by a forwarder. That's what makes router-assigned names work without configuration.
Set it to an explicit address if your gateway isn't the thing that knows your hostnames.

Add the zone your DHCP server uses. If it hands out `*.lan`, `lan` must be in `internalZones`
or those names will be sent to Cloudflare and come back NXDOMAIN.

## About mDNS, honestly

macOS and iOS advertise `*.local` over multicast DNS on port 5353. A unicast resolver is not
part of that conversation and cannot answer it. When a Mac resolves `Johns-iPhone.local`, it
does so directly over multicast — StellarDNS is not involved, and that's correct.

What StellarDNS handles is the unicast side: router-registered hostnames, AD records, and any
`.local` name a forwarder is configured to answer. If your `.local` names resolve through the
resolver at all, something upstream is proxying mDNS into unicast; the clamping rules above
still apply to those answers.

This distinction matters when debugging. "Internal names are slow" and "mDNS is slow" are
different problems with different fixes, and the disposition field in the query log tells you
which one you're looking at — `internal` means the resolver handled it, no entry at all means
the client never asked.

## Verifying

```sh
# TTL must be <= 30
dig @<resolver> my-nas.lan A +noall +answer

# Repeat after the device reconnects; the name must not gain a suffix
dig @<resolver> "John's iPhone.lan" A +short
```

Then check the client's own cache, because that's where the stubborn answers live:

| OS | Command |
|---|---|
| macOS | `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder` |
| Windows | `ipconfig /flushdns` |
| Linux (systemd-resolved) | `resolvectl flush-caches` |
| Linux (nscd) | `sudo systemctl restart nscd` |

If the name is correct on a freshly booted device but wrong on one that has been asleep all
day, the resolver is doing its job and the client is holding an old answer. The TTL clamp
bounds the damage to 30 seconds after the next lookup; it cannot retroactively shorten a TTL
already handed out.

## If it still goes wrong

- **Name resolves to a suffix that grows each time.** The TTL clamp isn't applying — check that
  the zone is really in `internalZones` and the disposition says `internal`, not `upstream`.
- **Internal names return NXDOMAIN instantly.** The zone is listed but nothing answers it, and
  `internalFallback` is `"off"` or pointing somewhere that doesn't know the name.
- **Everything internal takes 700 ms.** `internalTimeoutMs` is being hit: the fallback address
  is wrong or unreachable. Check `GET /api/forwarders`, which reports the detected gateway and
  the active fallback.
