'use strict';
/* Full-system simulator: drives the real resolver over UDP with a mixed workload — cache
 * hits, cold misses, blocked names, LANCache rewrites, local records and NXDOMAIN — and
 * checks both the answers and the latency distribution. This is the "does it hold together
 * under load" check that unit tests cannot give you.
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const dgram = require('dgram');
const { spawn } = require('child_process');
const dnsPacket = require('dns-packet');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, '.sim-data');
const DNS_PORT = 1083, WEB_PORT = 5393, FAKE_PORT = 15421, LIST_PORT = 15422, STUB_PORT = 18083;
const TOKEN = 'sim-token-0123456789';
const CONCURRENCY = 40;
const CACHE_IP = '10.0.0.5';
const LOCAL_IP = '10.0.0.9';

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });

// ---- blocklist served locally, so the simulator needs no internet
const listSrv = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(['ads.test', 'tracker.test', 'metrics.test'].join('\n'));
});
listSrv.listen(LIST_PORT, '127.0.0.1');

fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({
  dns: { host: '127.0.0.1', host6: false, port: DNS_PORT, tcp: false, ednsUdpSize: 1232 },
  web: { host: '127.0.0.1', port: WEB_PORT, apiToken: TOKEN },
  upstreams: [{ name: 'sim', address: '127.0.0.1', port: FAKE_PORT }],
  workers: 1, dot: false, doh: false, blockPagePort: STUB_PORT,
  cache: { maxEntries: 20000, maxHeapMB: 256, minTtl: 5, maxTtl: 3600, negMaxTtl: 60, serveStale: true, serveStaleMaxAge: 3600, prefetch: true, prefetchWindow: 10, snapshotIntervalSec: 300 },
  log: { ringSize: 500, file: false, maxFileBytes: 1048576, keepFiles: 1 },
  blocklists: [{ name: 'sim', url: `http://127.0.0.1:${LIST_PORT}/list.txt`, enabled: true }],
  blockAllowlist: [], blockedResponse: 'sinkhole', sinkholeIP: '', sinkholeIPv6: '',
  localRecords: [{ name: 'printer.lan', type: 'A', data: LOCAL_IP, ttl: 60 }],
  internalZones: ['lan'], internalFallback: false,
  categories: { steam: { enabled: true, target: CACHE_IP, target6: '', domains: ['lancache.steamcontent.com'] } },
  clientAcl: [], rateLimitPerClientQps: 0, subnetPolicies: [], conditionalForwarders: [], reverseForwarders: [],
  dnssec: 'passthrough', rebindingProtection: true, dnsCookies: false, caseRandomization: false,
  hedge: true, hedgeDelayMs: 40, blocklistRefreshHours: 24
}, null, 2));

// ---- upstream with realistic jitter
const fake = dgram.createSocket('udp4');
fake.on('message', (msg, rinfo) => {
  let q; try { q = dnsPacket.decode(msg); } catch { return; }
  const name = q.questions[0].name.toLowerCase();
  const nx = name.endsWith('.nx.test');
  const answers = nx ? [] : [{ name, type: 'A', ttl: 300, data: '203.0.113.' + (1 + (name.length % 200)) }];
  const out = dnsPacket.encode({
    type: 'response', id: q.id,
    flags: dnsPacket.RECURSION_DESIRED | dnsPacket.RECURSION_AVAILABLE | (nx ? 3 : 0),
    questions: q.questions, answers
  });
  setTimeout(() => { try { fake.send(out, rinfo.port, rinfo.address); } catch {} }, 4 + Math.floor(Math.random() * 20));
});
fake.bind(FAKE_PORT, '127.0.0.1');

// ---- small client pool: many in flight without exhausting ephemeral ports
function makePool(n) {
  const socks = [];
  for (let i = 0; i < n; i++) {
    const s = dgram.createSocket('udp4');
    s.pending = new Map();
    s.on('message', m => {
      const id = m.readUInt16BE(0);
      const p = s.pending.get(id);
      if (!p) return;
      s.pending.delete(id);
      try { p(m); } catch {}
    });
    s.on('error', () => {});
    socks.push(s);
  }
  let turn = 0;
  return {
    query(name, type = 'A') {
      const s = socks[turn++ % socks.length];
      return new Promise((resolve, reject) => {
        const id = Math.floor(Math.random() * 65535);
        const t0 = process.hrtime.bigint();
        const timer = setTimeout(() => { s.pending.delete(id); reject(new Error('client timeout')); }, 5000);
        s.pending.set(id, m => {
          clearTimeout(timer);
          let r; try { r = dnsPacket.decode(m); } catch (e) { return reject(e); }
          resolve({ r, ms: Number(process.hrtime.bigint() - t0) / 1e6 });
        });
        const pkt = dnsPacket.encode({
          type: 'query', id, flags: dnsPacket.RECURSION_DESIRED,
          questions: [{ type, name }],
          additionals: [{ type: 'OPT', name: '.', udpPayloadSize: 1232 }]
        });
        try { s.send(pkt, DNS_PORT, '127.0.0.1'); } catch (e) { clearTimeout(timer); s.pending.delete(id); reject(e); }
      });
    },
    close() { for (const s of socks) { try { s.close(); } catch {} } }
  };
}

const pct = (arr, p) => { if (!arr.length) return 0; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * p))]; };

async function main() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: { ...process.env, STELLARDNS_CONFIG: path.join(DATA, 'config.json'), STELLARDNS_DATA: DATA },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  const stop = () => { try { child.kill(); } catch {} try { fake.close(); } catch {} try { listSrv.close(); } catch {} };

  const pool = makePool(CONCURRENCY);
  await new Promise(r => setTimeout(r, 2500));   // boot + blocklist load

  // ---- workload: each entry is [name, class, expected answer or rcode]
  const jobs = [];
  for (let i = 0; i < 40; i++) for (let k = 0; k < 25; k++) jobs.push(['hot' + i + '.example.com', 'hit', 'upstream']);
  for (let i = 0; i < 160; i++) jobs.push(['cold' + i + '.example.com', 'miss', 'upstream']);
  for (let k = 0; k < 6; k++) for (const n of ['ads.test', 'tracker.test', 'metrics.test']) jobs.push([n, 'blocked', 'blocked']);
  for (let k = 0; k < 8; k++) jobs.push(['lancache.steamcontent.com', 'rewrite', CACHE_IP]);
  for (let k = 0; k < 8; k++) jobs.push(['printer.lan', 'local', LOCAL_IP]);
  for (let k = 0; k < 8; k++) jobs.push(['gone.nx.test', 'nxdomain', 'NXDOMAIN']);

  // shuffle so classes interleave the way real traffic does
  for (let i = jobs.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [jobs[i], jobs[j]] = [jobs[j], jobs[i]]; }

  const results = { hit: [], miss: [], blocked: [], rewrite: [], local: [], nxdomain: [] };
  const errors = [];
  let cursor = 0;
  const t0 = Date.now();

  const worker = async () => {
    while (cursor < jobs.length) {
      const [name, cls, expect] = jobs[cursor++];
      try {
        const { r, ms } = await pool.query(name);
        results[cls].push(ms);
        const ans = (r.answers || [])[0];
        if (cls === 'nxdomain') {
          if (r.rcode !== 'NXDOMAIN') errors.push(`${name}: expected NXDOMAIN, got ${r.rcode}`);
        } else if (cls === 'blocked') {
          const ip = ans && ans.data;
          if (!ip || !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) errors.push(`${name}: expected sinkhole IP, got ${ip || r.rcode}`);
        } else if (cls === 'rewrite' || cls === 'local') {
          if (!ans || ans.data !== expect) errors.push(`${name}: expected ${expect}, got ${ans && ans.data}`);
        } else if (r.rcode !== 'NOERROR' || !ans) errors.push(`${name}: ${r.rcode} with no answer`);
      } catch (e) { errors.push(`${name}: ${e.message}`); }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const elapsed = (Date.now() - t0) / 1000;
  const total = jobs.length;
  const all = Object.values(results).flat();

  const row = (label, arr, extra = '') => console.log(
    `  ${label.padEnd(10)} n=${String(arr.length).padStart(4)}  p50 ${pct(arr, 0.50).toFixed(1).padStart(6)}ms  ` +
    `p95 ${pct(arr, 0.95).toFixed(1).padStart(6)}ms  p99 ${pct(arr, 0.99).toFixed(1).padStart(6)}ms  ${extra}`);

  console.log('\n  StellarDNS simulator');
  console.log('  ' + '-'.repeat(66));
  console.log(`  ${total} queries in ${elapsed.toFixed(2)}s = ${Math.round(total / elapsed)} q/s, ${CONCURRENCY} in flight\n`);
  row('all', all);
  row('cache hit', results.hit);
  row('cache miss', results.miss);
  row('blocked', results.blocked);
  row('rewrite', results.rewrite);
  row('local', results.local);
  row('nxdomain', results.nxdomain);

  const hitRate = results.hit.length / (results.hit.length + results.miss.length) * 100;
  console.log(`\n  cache hit rate ${hitRate.toFixed(1)}%   errors ${errors.length}`);

  const checks = [
    ['no failed queries', errors.length === 0, errors.slice(0, 3).join(' | ')],
    ['hit rate above 70%', hitRate > 70, hitRate.toFixed(1) + '%'],
    ['miss p95 under 250ms', pct(results.miss, 0.95) < 250, pct(results.miss, 0.95).toFixed(1) + 'ms'],
    ['hit p95 under 25ms', pct(results.hit, 0.95) < 25, pct(results.hit, 0.95).toFixed(1) + 'ms'],
    ['every class answered correctly', errors.filter(e => /expected/.test(e)).length === 0, 'sinkhole, rewrite, local, nxdomain']
  ];
  let fails = 0;
  console.log('');
  for (const [name, ok, detail] of checks) { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!ok) fails++; }

  pool.close(); stop();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(`\n  ${checks.length - fails} passed, ${fails} failed`);
  if (fails) { console.error(log.split('\n').slice(-10).join('\n')); process.exit(1); }
  process.exit(0);
}

main().catch(e => { console.error(e); try { fake.close(); listSrv.close(); } catch {} process.exit(1); });
