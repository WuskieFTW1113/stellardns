#!/bin/sh
# Configure keepalived for a StellarDNS HA pair.
#   ./setup-ha.sh MASTER <VIP/CIDR> <this-node-ip> <peer-node-ip> [iface]
#   ./setup-ha.sh BACKUP <VIP/CIDR> <this-node-ip> <peer-node-ip> [iface]
set -e
ROLE=${1:?MASTER or BACKUP}
VIP=${2:?VIP e.g. 192.168.9.53/24}
SELF=${3:?this node IP}
PEER=${4:?peer node IP}
IFACE=${5:-eth0}
[ "$(id -u)" = "0" ] || { echo "run as root"; exit 1; }

if command -v apt-get >/dev/null 2>&1; then apt-get update -qq && apt-get install -y -qq keepalived dnsutils
elif command -v apk >/dev/null 2>&1; then apk add --no-cache keepalived bind-tools
else echo "install keepalived manually"; exit 1; fi

PRIO=150; [ "$ROLE" = "BACKUP" ] && PRIO=100
sed -e "s/state MASTER.*/state $ROLE/" \
    -e "s/priority 150.*/priority $PRIO/" \
    -e "s#192.168.9.53/24#$VIP#" \
    -e "s/unicast_src_ip 192.168.9.10.*/unicast_src_ip $SELF/" \
    -e "s/192.168.9.11 *#.*/$PEER/" \
    -e "s/interface eth0.*/interface $IFACE/" \
    "$(dirname "$0")/keepalived.conf" > /etc/keepalived/keepalived.conf

# verify the resolver answers the health name before enabling failover on it
if ! dig @127.0.0.1 +short +time=1 +tries=1 health.stellardns >/dev/null 2>&1; then
  echo "WARNING: health.stellardns did not answer on 127.0.0.1."
  echo "         Is StellarDNS running and >= v20? keepalived will hold this node in FAULT."
fi

systemctl enable --now keepalived 2>/dev/null || rc-update add keepalived default && rc-service keepalived restart
echo ""
echo "$ROLE configured. VIP $VIP follows the healthy node."
echo "  Point DHCP DNS at: ${VIP%%/*}   (and add a node's physical IP as secondary)"
echo "  Check ownership:   ip -br addr show | grep ${VIP%%/*}"
