# Deployment

Where to run it, how to wire it into the network, and what to open in the firewall.

## Choosing a home

| Option | Good for | Watch out for |
|---|---|---|
| **LXC on the router host** | Lowest latency, no extra hardware, snapshots | Container must have a static address; port 53 inside the container |
| **VM** | Isolation, easy rollback | ~200 MB RAM overhead you don't need |
| **Bare metal / mini PC** | Independent of the router, survives router reboots | One more device to power and patch |
| **Docker** | Portability | Binding 53 conflicts with host resolvers; not the recommended path |

A resolver is on the critical path for every device. Put it somewhere that boots before or
with the rest of the network, and give it a static address or a DHCP reservation.

## LXC

An unprivileged container is fine — the process runs as root *inside* the container's user
namespace, which is what lets it bind port 53. Nesting is not required.

```sh
# on the Proxmox host, with a Debian 12 template
pct create 120 local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst \
  --hostname stellardns --memory 512 --cores 2 --swap 512 \
  --net0 name=eth0,bridge=vmbr0,ip=192.168.9.10/24,gw=192.168.9.1 \
  --features nesting=0 --unprivileged 1 --onboot 1
pct start 120
pct exec 120 -- bash -c 'apt-get update && apt-get install -y curl'
pct push 120 stellardns-install.sh /root/stellardns-install.sh
pct exec 120 -- sh /root/stellardns-install.sh --yes
```

If binding 53 fails inside an unusual container runtime, check
`sysctl net.ipv4.ip_unprivileged_port_start` in the container — it must be `0` or the process
must hold `CAP_NET_BIND_SERVICE`.

Give it a fixed IP. DHCP on the resolver itself is a boot-order race: clients ask for DNS
before the resolver has an address.

## Wiring the network

1. **Router DHCP → DNS server = resolver IP.** Option 6, one address. Not two.
2. **No public secondary.** A secondary of `1.1.1.1` means every client silently bypasses
   blocking whenever the resolver is slow to answer. If you need redundancy, run a second
   StellarDNS and list it.
3. **Turn off the router's DNS proxy** on the LAN interface if it has one. Otherwise some
   clients get the router's cache and never reach the resolver.
4. **Reserve the address** in DHCP, or configure it statically on the host.

### Conditional forwarding back to the router

If the router owns your internal names, forward those zones to it rather than letting the
resolver guess:

```json
{
  "internalZones": ["lan", "home.arpa"],
  "conditionalForwarders": [
    { "zone": "lan", "upstreams": [{ "address": "192.168.9.1", "port": 53 }] }
  ]
}
```

This creates a loop if the router is *also* configured to forward to StellarDNS. The loop
guard (`forwardLoopGuard`) refuses it, but the correct fix is one direction only: router →
resolver for public names, resolver → router for internal zones.

## Ports and firewall

| Port | Proto | Who needs it | Exposure |
|---|---|---|---|
| 53 | UDP + TCP | LAN clients | LAN only — never the internet |
| 853 | TCP | DoT clients | LAN only |
| 8443 | TCP | DoH clients | LAN only |
| 5380 | TCP | You, the console | LAN, or loopback behind a proxy |
| 8053 | TCP | Clients, `blockpage` mode only | LAN |
| 80 | TCP | Clients, `sinkhole` mode only | LAN; must be free on the host |

An open recursive resolver on the internet is a DNS amplification weapon within hours. There
is no rate limit that makes that safe. Firewall 53/853/8443 to your LAN prefix and leave them
there:

```sh
# nftables
nft add rule inet filter input ip saddr 192.168.9.0/24 udp dport 53 accept
nft add rule inet filter input ip saddr 192.168.9.0/24 tcp dport { 53, 853, 8443 } accept
nft add rule inet filter input tcp dport 53 drop
```

## TLS

A self-signed certificate is generated on first run and preserved across upgrades. Two honest
options:

- **Trust it.** Import the certificate into your clients' trust stores. This is fine on a home
  network and avoids a dependency on an ACME challenge that a resolver can't easily satisfy.
- **Terminate elsewhere.** Put a reverse proxy with a real certificate in front of 8443/853 and
  point it at the resolver. The console can stay on loopback (`web.host: "127.0.0.1"`).

DoH clients that validate certificates will fail against an untrusted self-signed cert — that's
the client doing its job, not a resolver bug. See
[Troubleshooting](Troubleshooting#tls-warnings-or-doh-clients-refuse-to-connect).

## Service management

systemd:

```sh
systemctl status stellardns
journalctl -u stellardns -f
systemctl restart stellardns
```

OpenRC (Alpine):

```sh
rc-service stellardns status
rc-service stellardns restart
tail -f /var/log/stellardns.log
```

The installer writes the unit for whichever one it detected. Both start after the network is
up, which is the only ordering that matters here.

## Verifying the deployment

```sh
# from a client, not the resolver
dig @192.168.9.10 example.com +short
dig @192.168.9.10 example.com +tcp +short          # TCP path
dig @192.168.9.10 +short example.com @1.1.1.1      # sanity: upstream reachable from resolver

# console reachable from the LAN
curl -s http://192.168.9.10:5380/api/version
```

Then check the console's query log from a phone. If the queries appear with the phone's IP,
the whole path works. If they don't, the client isn't using you yet — which is a DHCP problem,
not a resolver problem.
