## What this changes

<!-- One paragraph. If it fixes something, what was the symptom? -->

## Checks

- [ ] `node --check server.js`
- [ ] `node test/smoke.js`
- [ ] `node test/fastpath.js` (if upstreams or the cache changed)
- [ ] `node test/sinkhole.js` (if any block path changed)
- [ ] `node test/simulate.js` q/s and p95 numbers, if the query path changed

## Notes

- The per-query path stays allocation-free: no config reads, no `Object.entries` / `filter` /
  `includes` per query. Config is compiled into an index when it changes.
- New config keys must have a default, so an existing `config.json` keeps working unchanged.
- Does this change user-visible behaviour that the README, a wiki page or `CHANGELOG.md`
  describes? Update it in this PR.
