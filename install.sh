#!/bin/sh
# StellarDNS — install from a git checkout.
#   sudo ./install.sh
# Env: SD_ADMIN_PASS, SD_CACHE_IP, SD_YES=1, SD_DIR (default /opt/stellardns)
set -e
SRC=$(cd "$(dirname "$0")" && pwd)
SD_DIR="${SD_DIR:-/opt/stellardns}"
WEB_PORT=5380
[ "$(id -u)" = "0" ] || { echo "run as root (sudo ./install.sh)"; exit 1; }

if command -v apt-get >/dev/null 2>&1; then PKG=apt
elif command -v apk >/dev/null 2>&1; then PKG=apk
else echo "need apt or apk (Debian/Ubuntu/Alpine)"; exit 1; fi

UPGRADE=0; [ -f "$SD_DIR/config.json" ] && UPGRADE=1

if ! command -v node >/dev/null 2>&1; then
  echo "installing Node.js..."
  if [ "$PKG" = apt ]; then apt-get update -qq && apt-get install -y -qq nodejs npm openssl dnsutils curl
  else apk add --no-cache nodejs npm openssl bind-tools curl; fi
fi

[ "$UPGRADE" = "1" ] && {
  command -v systemctl >/dev/null 2>&1 && systemctl stop stellardns 2>/dev/null || true
  command -v rc-service >/dev/null 2>&1 && rc-service stellardns stop 2>/dev/null || true
  sleep 1
}

mkdir -p "$SD_DIR"
cp "$SRC/server.js" "$SD_DIR/"
mkdir -p "$SD_DIR/public" && cp "$SRC/public/index.html" "$SD_DIR/public/"
[ -d "$SRC/ha" ] && cp -r "$SRC/ha" "$SD_DIR/"
cp "$SRC/package.json" "$SD_DIR/" 2>/dev/null || true
[ -f "$SD_DIR/config.json" ] || cp "$SRC/config.example.json" "$SD_DIR/config.json"
( cd "$SD_DIR" && npm install --omit=dev >/dev/null 2>&1 || npm install --omit=dev )

if command -v systemctl >/dev/null 2>&1; then
  systemctl is-active -q systemd-resolved 2>/dev/null && {
    mkdir -p /etc/systemd/resolved.conf.d
    printf '[Resolve]\nDNSStubListener=no\n' > /etc/systemd/resolved.conf.d/stellardns.conf
    systemctl restart systemd-resolved || true; }
  cp "$SRC/systemd/stellardns.service" /etc/systemd/system/
  systemctl daemon-reload; systemctl enable stellardns >/dev/null 2>&1 || true
  systemctl restart stellardns
elif command -v rc-update >/dev/null 2>&1; then
  cp "$SRC/systemd/stellardns.openrc" /etc/init.d/stellardns; chmod +x /etc/init.d/stellardns
  rc-update add stellardns default >/dev/null 2>&1 || true
  rc-service stellardns restart >/dev/null 2>&1 || rc-service stellardns start
else
  echo "no init system — run manually: node $SD_DIR/server.js"
fi
sleep 4

TOKEN=$(sed -n 's/.*"apiToken": *"\([^"]*\)".*/\1/p' "$SD_DIR/config.json" | head -1)
[ -n "$SD_ADMIN_PASS" ] && curl -s -X POST -H "x-api-token: $TOKEN" -H "Content-Type: application/json" \
  -d "{\"username\":\"admin\",\"newPassword\":\"$SD_ADMIN_PASS\"}" "http://127.0.0.1:$WEB_PORT/api/passwd" >/dev/null 2>&1
[ -n "$SD_CACHE_IP" ] && curl -s -X POST -H "x-api-token: $TOKEN" -H "Content-Type: application/json" \
  -d "{\"defaultTarget\":\"$SD_CACHE_IP\"}" "http://127.0.0.1:$WEB_PORT/api/import-uklans" >/dev/null 2>&1

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo ""
echo "StellarDNS installed to $SD_DIR"
echo "  Console   : http://${IP:-<host>}:$WEB_PORT"
echo "  API token : $TOKEN"
[ "$UPGRADE" = "0" ] && echo "  Admin password: journalctl -u stellardns | grep auth"
echo ""
