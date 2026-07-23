# StellarDNS LXC — Proxmox settings

## 1. Create the container (on the Proxmox host)

```bash
# Debian 12 template example — Alpine works identically (use the alpine template)
pct create 200 local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst \
  --hostname stellardns \
  --unprivileged 1 \
  --features nesting=1 \
  --cores 2 \
  --cpulimit 2 \
  --memory 2048 \
  --swap 0 \
  --rootfs local-lvm:8 \
  --net0 name=eth0,bridge=vmbr0,ip=10.0.0.53/24,gw=10.0.0.1 \
  --onboot 1 \
  --startup order=1
```

Adjust: VMID (200), storage (`local-lvm`), bridge (`vmbr0`), and the static IP —
give it a **static IP**, since this box becomes the DNS your DHCP hands out.

## 2. Resource sizing

| Setting | Value | Why |
|---|---|---|
| cores | 2 | Node is single-threaded for the query path; 2 gives the event loop + timers/logging headroom. This isn't the AF_XDP build — it doesn't need isolated cores. |
| cpulimit | 2 | Hard cap so a runaway can't eat the node |
| cpuunits | 2048 (optional) | Above-default scheduler weight — DNS latency matters more than most guests, worth priority if the node runs hot |
| memory | 2048 MB | Node heap + cache Map + blocklists. 500k-entry cache plus a multi-million-entry blocklist fits comfortably. The 8GB hugepage figure from the architecture doc is for the future native build, NOT this one. |
| swap | 0 | Never let the DNS path page out |
| rootfs | 8 GB | Server is tiny; the growth is query logs (capped at 50MB x 3 by config) and snapshots |

## 3. Required config lines (`/etc/pve/lxc/200.conf`)

Nothing exotic — the stock v1 needs no seccomp changes, no /dev passthrough, no privilege:

```
unprivileged: 1
features: nesting=1
onboot: 1
startup: order=1
```

- `unprivileged: 1` — works fine; binding port 53 inside the container is allowed
  (the container's root maps to an unprivileged host UID, but in-namespace it can
  bind low ports; the systemd unit also carries CAP_NET_BIND_SERVICE).
- `nesting=1` — lets systemd inside the CT behave properly on Debian/Ubuntu guests.
- `startup: order=1` — DNS should come up before everything that depends on it.
- **No** `lxc.seccomp` edits needed — that requirement in the architecture doc applies
  to the future io_uring native build, not this Node version.

## 4. Optional: NVMe-backed data dir (bind mount)

Point the snapshot/logs/blocklist state at your DC U.2 pool instead of the rootfs:

```bash
# host: create a dataset/dir on the NVMe pool
zfs create nvmepool/stellardns    # or: mkdir -p /nvme/stellardns

pct set 200 -mp0 /nvmepool/stellardns,mp=/opt/stellardns/data,backup=1
```

Unprivileged CT + host dir: fix ownership once from the host
(root in CT 200 = host UID 100000 by default):

```bash
chown -R 100000:100000 /nvmepool/stellardns
```

## 5. Inside the container

```bash
pct enter 200
apt update && apt install -y curl tar          # (apk add curl tar on Alpine)
# copy stellardns.tar.gz in (pct push from the host works too):
#   pct push 200 stellardns.tar.gz /root/stellardns.tar.gz
cd /root && tar xzf stellardns.tar.gz && cd stellardns && ./install.sh
```

Installer handles Node, the systemd/OpenRC service, and systemd-resolved's stub
listener automatically. Token lands in `/opt/stellardns/config.json`.

## 6. Point the network at it

- OPNsense → Services → DHCPv4 → your LAN scope → DNS servers: `10.0.0.53`
- Or per-VLAN if you're staging the rollout.
- Keep OPNsense's own resolver as a temporary secondary during testing, then remove
  it — two resolvers with different policy tables means rewrites only apply
  ~half the time.

## 7. Firewall rules worth adding (OPNsense)

- Allow LAN → 10.0.0.53 : 53/udp+tcp, 5380/tcp (UI — restrict to your admin VLAN)
- Block LAN → WAN : 53 (force everything through StellarDNS; catches hardcoded
  8.8.8.8-style devices)
- Block LAN → known public DoH endpoints : 443 (the DoH bypass mitigation from the doc)

## 8. Later: the native AF_XDP build changes this recipe

When the Rust/AF_XDP core happens, THAT's when you revisit: privileged CT (or
physical NIC passthrough via `lxc.net0.type: phys`), custom seccomp profile for
io_uring, host-level hugepage reservation, and 6-8 dedicated cores. Don't apply
any of that now — it buys nothing for the Node build.
