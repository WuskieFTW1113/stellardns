#!/bin/bash
# Build a single-file AppImage from this checkout.
#
#   ./build.sh                 uses node from PATH
#   ./build.sh --node /usr/bin/node
#
# The result runs the shared Node core; the AppImage is a delivery format, not a second
# implementation. It needs appimagetool on PATH or will download it.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"          # client/
NODE_BIN=""
for arg in "$@"; do
  case "$arg" in
    --node=*) NODE_BIN="${arg#--node=}" ;;
    --node) shift; NODE_BIN="${1:-}" ;;
  esac
done
[ -n "$NODE_BIN" ] || NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "no node binary found; pass --node=/path/to/node" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
APPDIR="$WORK/StellarDNS.AppDir"
mkdir -p "$APPDIR/usr/bin" "$APPDIR/usr/share/stellardns-client" "$APPDIR/usr/share/applications" \
         "$APPDIR/usr/share/icons/hicolor/scalable/apps"

# Mail the core, the GUI and the dependency. node_modules is copied rather than installed
# so the build produces the same bytes on every machine.
cp -r "$ROOT/src" "$APPDIR/usr/share/stellardns-client/"
cp -r "$ROOT/public" "$APPDIR/usr/share/stellardns-client/"
cp "$ROOT/package.json" "$APPDIR/usr/share/stellardns-client/"
mkdir -p "$APPDIR/usr/share/stellardns-client/node_modules"
cp -r "$ROOT/../node_modules/dns-packet" "$APPDIR/usr/share/stellardns-client/node_modules/" 2>/dev/null || \
  cp -r "$ROOT/node_modules/dns-packet" "$APPDIR/usr/share/stellardns-client/node_modules/" 2>/dev/null || \
  echo "warning: dns-packet not vendored; the AppImage will need it beside the core"

cp "$NODE_BIN" "$APPDIR/usr/bin/node"
chmod +x "$APPDIR/usr/bin/node"
cp "$HERE/AppRun" "$APPDIR/AppRun"
chmod +x "$APPDIR/AppRun"
cp "$HERE/stellardns-client.desktop" "$APPDIR/usr/share/applications/"
cp "$HERE/stellardns-client.desktop" "$APPDIR/stellardns-client.desktop"

cat > "$APPDIR/usr/share/icons/hicolor/scalable/apps/stellardns-client.svg" <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#0d121c"/>
<path d="M32 12l4.8 14.4L51 32l-14.2 5.6L32 52l-4.8-14.4L13 32l14.2-5.6z" fill="#4ade80"/></svg>
SVG
cp "$APPDIR/usr/share/icons/hicolor/scalable/apps/stellardns-client.svg" "$APPDIR/stellardns-client.svg"

TOOL="$(command -v appimagetool || true)"
if [ -z "$TOOL" ]; then
  echo "appimagetool not found — downloading it"
  curl -fsSL -o "$WORK/appimagetool" \
    https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage
  chmod +x "$WORK/appimagetool"
  TOOL="$WORK/appimagetool"
fi

OUT="${OUT:-$PWD/StellarDNS-$(uname -m).AppImage}"
ARCH="$(uname -m)" "$TOOL" --appimage-extract-and-run "$APPDIR" "$OUT" 2>/dev/null || \
  ARCH="$(uname -m)" "$TOOL" "$APPDIR" "$OUT"
echo "built $OUT"
