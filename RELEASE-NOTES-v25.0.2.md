# StellarDNS v25.0.2 — Vega

A one-file repair for anyone who upgraded to 25.0.1 through the console.

## The Updates view disappeared

`applyUpdate()` replaces `server.js` and `public/index.html`, both fetched from the tag on
GitHub. The repository's `public/index.html` was older than the console the v25 installer
carried: 73,120 bytes against 77,001, and it has no Updates view at all. The upgrade did
exactly what it was told — installed 25.0.1's `server.js` and an older console — and the
panel that had just performed the update was gone.

The v25 console is committed now. Nothing else changed.

## If you already lost the view

The updater keeps a backup of what it replaced, so the previous console is still on the
machine. As root:

```sh
cp /opt/stellardns/data/update/backup-25.0.0/public/index.html \r
   /opt/stellardns/public/index.html
```

Reload the console and Updates is back; it will then offer 25.0.2. Reinstalling from the
v25.0.2 installer does the same thing.

## Upgrading

Console → Updates, or re-run the installer. Config, users, cache, logs and TLS material
are preserved.
