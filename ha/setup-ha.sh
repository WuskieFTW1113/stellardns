#!/bin/sh
# Run on each StellarDNS node. Usage: ./setup-ha.sh <MASTER|BACKUP> <VIP/CIDR> [iface]
set -e
ROLE=${1:?MASTER or BACKUP}; VIP=${2:?VIP e.g. 192.168.9.53/24}; IFACE=${3:-eth0}
apt-get update -qq && apt-get install -y -qq keepalived dnsutils
PRIO=150; [ "$ROLE" = "BACKUP" ] && PRIO=100
sed -e "s/state MASTER.*/state $ROLE/" -e "s/priority 150.*/priority $PRIO/" \
    -e "s#192.168.9.53/24#$VIP#" -e "s/interface eth0/interface $IFACE/" \
    "$(dirname "$0")/keepalived.conf" > /etc/keepalived/keepalived.conf
systemctl enable --now keepalived
echo "$ROLE up. VIP $VIP will follow the healthy node. Point DHCP DNS at ${VIP%%/*}."
