'use strict';
/* Finding a resolver on the LAN.
 * No mDNS: StellarDNS is a plain HTTP console, and a /24 sweep with a short timeout finishes
 * in a few seconds. It probes only addresses this machine can already reach, and identifies a
 * server by its /api/client/ping response rather than by an open port.
 */
const http = require('http');
const os = require('os');
const { supportsRules } = require('./rules');

const DEFAULT_PORT = 5380;

/* /api/client/ping is a v25 route. A v24 server does not have it and its auth gate answers 401 to
 * any unknown /api/ path, so a 401 here is a StellarDNS box that is simply too old — not a host
 * that said nothing. Ask /api/version, which is unauthenticated on both, before giving up on it. */
function getJson(host, port, path, timeoutMs) {
  return new Promise(resolve => {
    const req = http.get({ host, port, path, timeout: timeoutMs }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function probe(host, port = DEFAULT_PORT, timeoutMs = 600) {
  return new Promise(resolve => {
    const req = http.get({ host, port, path: '/api/client/ping', timeout: timeoutMs }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', async () => {
        if (res.statusCode === 200) {
          try {
            const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (j && j.service === 'stellardns') {
              const version = String(j.version || '');
              return resolve({
                host, port, version, codename: j.codename || '', url: `http://${host}:${port}`,
                rulesAvailable: supportsRules(version)
              });
            }
          } catch {}
          return resolve(null);
        }
        const j = await getJson(host, port, '/api/version', timeoutMs);
        if (j && j.name === 'stellardns') {
          const version = String(j.version || '');
          return resolve({
            host, port, version, codename: j.codename || '', url: `http://${host}:${port}`,
            rulesAvailable: supportsRules(version)
          });
        }
        resolve(null);
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function localNets() {
  const nets = [];
  for (const [iface, addrs] of Object.entries(os.networkInterfaces() || {})) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      nets.push({ iface, prefix: a.address.split('.').slice(0, 3).join('.') });
    }
  }
  return nets;
}

/* Scan the /24 of each non-loopback interface. Two networks covers a normal homelab (LAN plus
 * a second VLAN); more than that turns a two-second scan into a ten-second one. */
async function scan(opts = {}) {
  const port = opts.port || DEFAULT_PORT;
  const timeoutMs = opts.timeoutMs || 450;
  const concurrency = opts.concurrency || 64;
  const hosts = [];
  if (opts.extraHosts) hosts.push(...opts.extraHosts);
  for (const net of localNets().slice(0, 2)) {
    for (let i = 1; i < 255; i++) hosts.push(`${net.prefix}.${i}`);
  }
  const unique = [...new Set(hosts)];
  const found = [];
  let cursor = 0;
  async function worker() {
    while (cursor < unique.length) {
      const host = unique[cursor++];
      const hit = await probe(host, port, timeoutMs);
      if (hit) found.push(hit);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, worker));
  return found.sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }));
}

module.exports = { probe, scan, localNets, supportsRules, getJson, DEFAULT_PORT };
