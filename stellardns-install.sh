#!/bin/sh
# =============================================================================
#  StellarDNS — installer
#  A fast, gaming-oriented DNS server: LANCache rewrites, launcher toggles,
#  AdGuard blocklists, DoT/DoH, a web console, and per-device policy.
#
#  Works on: Debian, Ubuntu, Alpine  (bare metal, VM, or LXC)
#  Requires: root
#
#  Quick start:
#     sudo sh stellardns-install.sh
#
#  Non-interactive (for automation), set any of these env vars:
#     SD_ADMIN_PASS=secret   SD_CACHE_IP=10.0.0.5   SD_YES=1   sudo -E sh stellardns-install.sh
# =============================================================================
set -e

SD_DIR=/opt/stellardns
SD_WEB_PORT=5380
EXPECTED_SHA="fc34d077f9974750099e2f4795745814b2abbd40dc58f66fcbc394975878db33"

say(){ printf '%s\n' "$*"; }
bold(){ printf '\033[1m%s\033[0m\n' "$*"; }
ok(){ printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn(){ printf '  \033[33m!\033[0m %s\n' "$*"; }
die(){ printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }
ask(){ # ask "prompt" "default" ; result on stdout
  _p="$1"; _d="$2"
  if [ "${SD_YES:-}" = "1" ]; then printf '%s' "$_d"; return; fi
  if [ -n "$_d" ]; then printf '%s [%s]: ' "$_p" "$_d" >&2; else printf '%s: ' "$_p" >&2; fi
  read -r _a </dev/tty 2>/dev/null || _a=""
  [ -z "$_a" ] && _a="$_d"
  printf '%s' "$_a"
}

[ "$(id -u)" = "0" ] || die "run as root (try: sudo sh $0)"

bold ""
bold "  ✦ StellarDNS installer"
say  "  ─────────────────────────────────────────────"
say  ""

# ---- detect OS / package manager ----
if command -v apt-get >/dev/null 2>&1; then PKG=apt; 
elif command -v apk >/dev/null 2>&1; then PKG=apk;
else die "unsupported system (need apt or apk — Debian/Ubuntu/Alpine)"; fi
ok "detected package manager: $PKG"

# ---- upgrade vs fresh ----
UPGRADE=0
if [ -f "$SD_DIR/config.json" ]; then
  UPGRADE=1
  ok "existing install found at $SD_DIR — will upgrade (settings preserved)"
fi

# ---- gather answers (fresh install only) ----
ADMIN_PASS="${SD_ADMIN_PASS:-}"
CACHE_IP="${SD_CACHE_IP:-}"
if [ "$UPGRADE" = "0" ]; then
  say ""
  bold "  Setup"
  if [ -z "$ADMIN_PASS" ]; then
    ADMIN_PASS=$(ask "  Choose an admin password for the web console (blank = auto-generate)" "")
  fi
  if [ -z "$CACHE_IP" ]; then
    CACHE_IP=$(ask "  LANCache server IP for game rewrites (blank = skip, set later in UI)" "")
  fi
fi

# ---- extract + verify payload ----
say ""
bold "  Installing"
PL=$(awk '/^__PAYLOAD_BELOW__$/{print NR+1; exit}' "$0")
tail -n +"$PL" "$0" | base64 -d > /tmp/stellardns.tar.gz
if command -v sha256sum >/dev/null 2>&1; then
  echo "$EXPECTED_SHA  /tmp/stellardns.tar.gz" | sha256sum -c >/dev/null 2>&1 \
    && ok "payload verified" || die "payload checksum mismatch — re-download the installer"
else warn "sha256sum not available — skipping integrity check"; fi

# ---- dependencies ----
if ! command -v node >/dev/null 2>&1; then
  say "  installing Node.js + tools (first run only)…"
  if [ "$PKG" = apt ]; then apt-get update -qq && apt-get install -y -qq nodejs npm openssl dnsutils curl >/dev/null
  else apk add --no-cache nodejs npm openssl bind-tools curl >/dev/null; fi
  ok "installed Node.js $(node -v 2>/dev/null)"
else
  if [ "$PKG" = apt ]; then apt-get install -y -qq openssl dnsutils curl >/dev/null 2>&1 || true
  else apk add --no-cache openssl bind-tools curl >/dev/null 2>&1 || true; fi
  ok "Node.js present ($(node -v 2>/dev/null))"
fi

# ---- files ----
mkdir -p "$SD_DIR"
tar xzf /tmp/stellardns.tar.gz -C /tmp
if [ "$UPGRADE" = "1" ]; then
  cp /tmp/stellardns/server.js "$SD_DIR/server.js"
  cp -r /tmp/stellardns/public "$SD_DIR/"
  cp -r /tmp/stellardns/ha "$SD_DIR/" 2>/dev/null || true
  cp /tmp/stellardns/README.md /tmp/stellardns/package.json /tmp/stellardns/package-lock.json "$SD_DIR/" 2>/dev/null || true
else
  cp -r /tmp/stellardns/. "$SD_DIR"/
fi
( cd "$SD_DIR" && npm install --omit=dev >/dev/null 2>&1 || npm install --omit=dev >/dev/null )
ok "files installed to $SD_DIR"

# ---- free port 53 (systemd-resolved stub) ----
if command -v systemctl >/dev/null 2>&1 && systemctl is-active -q systemd-resolved 2>/dev/null; then
  mkdir -p /etc/systemd/resolved.conf.d
  printf '[Resolve]\nDNSStubListener=no\n' > /etc/systemd/resolved.conf.d/stellardns.conf
  systemctl restart systemd-resolved 2>/dev/null || true
  ok "freed port 53 (disabled systemd-resolved stub listener)"
fi

# ---- service ----
if command -v systemctl >/dev/null 2>&1; then
  [ -f "$SD_DIR/stellardns.service" ] && cp "$SD_DIR/stellardns.service" /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable stellardns >/dev/null 2>&1 || true
  systemctl restart stellardns
  INIT=systemd
elif command -v rc-update >/dev/null 2>&1; then
  [ -f "$SD_DIR/stellardns.openrc" ] && cp "$SD_DIR/stellardns.openrc" /etc/init.d/stellardns && chmod +x /etc/init.d/stellardns
  rc-update add stellardns default >/dev/null 2>&1 || true
  rc-service stellardns restart >/dev/null 2>&1 || rc-service stellardns start
  INIT=openrc
else
  warn "no init system — start manually: node $SD_DIR/server.js"
  INIT=manual
fi
ok "service started ($INIT)"
sleep 3

# ---- read token, set admin password (fresh installs) ----
TOKEN=$(sed -n 's/.*"apiToken": *"\([^"]*\)".*/\1/p' "$SD_DIR/config.json" | head -1)
GEN_PASS=""
if [ "$UPGRADE" = "0" ]; then
  # capture the auto-generated admin password from the service log if we need to show it
  if command -v journalctl >/dev/null 2>&1; then
    GEN_PASS=$(journalctl -u stellardns --no-pager 2>/dev/null | sed -n "s/.*admin' \/ '\([^']*\)'.*/\1/p" | tail -1)
  fi
  if [ -n "$ADMIN_PASS" ]; then
    # set the chosen password via API (waits for web to be up)
    i=0; while [ $i -lt 10 ]; do
      if curl -s -o /dev/null -H "x-api-token: $TOKEN" "http://127.0.0.1:$SD_WEB_PORT/api/whoami"; then break; fi
      i=$((i+1)); sleep 1
    done
    curl -s -X POST -H "x-api-token: $TOKEN" -H "Content-Type: application/json" \
      -d "{\"username\":\"admin\",\"newPassword\":\"$ADMIN_PASS\"}" \
      "http://127.0.0.1:$SD_WEB_PORT/api/passwd" >/dev/null 2>&1 \
      && ok "admin password set" || warn "could not set admin password automatically"
  fi
fi

# ---- optional uklans import ----
if [ -n "$CACHE_IP" ]; then
  curl -s -X POST -H "x-api-token: $TOKEN" -H "Content-Type: application/json" \
    -d "{\"defaultTarget\":\"$CACHE_IP\"}" "http://127.0.0.1:$SD_WEB_PORT/api/import-uklans" >/dev/null 2>&1 \
    && ok "imported game CDN list (uklans) → $CACHE_IP" || warn "uklans import skipped"
fi

# ---- verify ----
if command -v dig >/dev/null 2>&1; then
  dig @127.0.0.1 example.com +short +time=2 +tries=1 >/dev/null 2>&1 && ok "resolver answering on port 53" || warn "resolver not answering yet — check logs"
fi

IP=$(hostname -I 2>/dev/null | awk '{print $1}'); [ -z "$IP" ] && IP="<this-host>"

say ""
bold "  ✦ StellarDNS is running"
say  "  ─────────────────────────────────────────────"
say  "  Web console : http://$IP:$SD_WEB_PORT"
if [ "$UPGRADE" = "1" ]; then
  say  "  Sign in     : your existing account (unchanged)"
else
  say  "  Username    : admin"
  if [ -n "$ADMIN_PASS" ]; then
    say  "  Password    : (the one you chose)"
  elif [ -n "$GEN_PASS" ]; then
    say  "  Password    : $GEN_PASS"
    say  "                (auto-generated — change it in the console)"
  else
    say  "  Password    : run  journalctl -u stellardns | grep '\[auth\]'"
  fi
fi
say  ""
say  "  Endpoints   : DNS 53 (UDP/TCP)   DoT 853   DoH 8443/dns-query"
say  "  API token   : $TOKEN"
say  ""
say  "  Next step   : point your router/devices' DNS at $IP"
say  "  Manage      : $INIT — e.g. 'systemctl status stellardns' or 'rc-service stellardns status'"
say  "  Config file : $SD_DIR/config.json"
say  ""
exit 0
__PAYLOAD_BELOW__
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
