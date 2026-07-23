# Contributing

## Running from source

```sh
npm install
cp config.example.json config.json
node server.js
```

For local testing, point it at high ports so you don't need root:

```json
{ "dns": { "host": "127.0.0.1", "port": 5353 },
  "web": { "host": "127.0.0.1", "port": 5380, "apiToken": "dev" },
  "dotPort": 8853, "dohPort": 8443, "blockPagePort": 8053, "workers": 1 }
```

Query it with `dig @127.0.0.1 -p 5353 example.com`.

## Before opening a PR

```sh
node --check server.js
```

If you touch the **query path**, please measure it. The single most common source of
bugs in this project has been work that is cheap with an empty config and expensive with
a populated one.

```sh
# CPU profile under load
node --cpu-prof --cpu-prof-dir=./prof server.js
```

Two rules that matter more than style here:

1. **Nothing on the query path may read configuration directly.** Compile config into an
   index when it changes; look it up per query. No `Object.entries()`, no
   `Array.filter()`, no `Array.includes()` on the hot path.
2. **Anything that grows per query must be bounded** — by size, not only by age. A
   time-based cutoff is not a bound when the input arrives in bursts.

## Reporting bugs

Include:

```sh
journalctl -u stellardns -n 100
curl -s -H "x-api-token: <token>" http://127.0.0.1:5380/api/stats
```

Node version, OS, and whether you're on bare metal / VM / container. Container matters:
memory budgets are derived from the cgroup limit.
