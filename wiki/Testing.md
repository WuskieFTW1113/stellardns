# Testing

Four suites. None of them needs root, port 53, or internet access — they bind high ports and
point the resolver at a local test config. That means you can run the whole set on a laptop
while something else is using the machine's DNS.

## Running them

```sh
cd stellardns
node test/smoke.js
node test/fastpath.js
node test/sinkhole.js
node test/simulate.js
```

Each exits non-zero on failure and prints a per-check line. `simulate.js` prints a latency
report rather than a pass/fail summary, because it's measuring rather than asserting.

## What each one covers

| Suite | Checks | Proves |
|---|---|---|
| `smoke.js` | 16 | Boot, HTTP API, auth, stats shape, Prometheus metrics, cache behaviour, config handling |
| `fastpath.js` | 3 | A cached answer is served without touching the upstream — the whole point of the cache |
| `sinkhole.js` | 7 | Auto-discovered sinkhole address, stub server, CORS echo, response shape |
| `simulate.js` | 5 | Throughput, hit rate, hit/miss latency percentiles under a realistic query mix |

The isolation mechanism is two environment variables, which is also how you'd run a second
instance by hand:

```sh
STELLARDNS_CONFIG=/tmp/sd/config.json STELLARDNS_DATA=/tmp/sd node server.js
```

Each suite creates its own temp directory, writes a minimal config with high ports, starts the
server as a child process, waits for `/api/whoami`, runs its checks, and kills the child.

## Reading the numbers

Last recorded run on a 2-core VM, 1,202 queries:

| Metric | Value |
|---|---|
| Throughput | 9,540 q/s |
| Cache hit rate | 86.2% |
| Hit p95 | 11.4 ms |
| Miss p95 | 24.7 ms |
| Errors | 0 |

Two caveats, both important:

- **These are loopback numbers.** Real clients add network latency on both sides; the shape of
  the distribution is what transfers, not the absolute values.
- **Throughput is not the interesting number.** A home network asks a few hundred queries a
  minute. The hit rate and the miss p95 are the ones that describe how the network feels.

## fastpath: the check that matters most

`fastpath.js` measures the difference between a path that hits the cache and one that goes
upstream by delaying the upstream artificially. The assertion is that a cached answer returns
in a small constant time regardless of what the upstream is doing — if the delay shows up in
the cached result, the cache isn't on the query path, and every other latency number in this
project is fiction.

That's why it exists as its own suite rather than a line in smoke.

## sinkhole

The suite starts the resolver with `blockedResponse: "sinkhole"` and no `sinkholeIP`, then
checks that:

- an address was discovered from the default route (not hard-coded);
- blocked names answer with that address;
- the stub server on port 80 answers and echoes CORS headers;
- the answer is a normal NOERROR response, not NXDOMAIN or `0.0.0.0`.

If the test host has no usable default route, discovery returns a fallback — the suite asserts
the fallback is a valid address rather than a specific one, which is why it passes in CI.

## simulate

`simulate.js` drives the server with a synthetic mix: a Zipf-distributed set of names, some
repeated, some unique, some oversized, some negative. It reports percentiles and the hit rate.

It's the only suite where a regression is a judgement call — numbers move between runs and
between machines. Compare against a previous run on the same host rather than against the table
above.

## Adding a check

Follow the existing pattern: create a temp dir, write a minimal config, spawn
`node server.js` with `STELLARDNS_CONFIG` and `STELLARDNS_DATA` set, poll `/api/whoami` until
it answers, then run assertions and kill the child in a `finally`. Don't bind 53, don't assume
a network, and clean up the temp dir.

A test that needs root or a real upstream will be skipped by contributors and eventually
deleted. Keep the suites runnable by anyone who clones the repo.
