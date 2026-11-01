'use strict';
/* StellarDNS smoke test — no root, no port 53, no external network.
 * Boots a fake upstream on :15353, runs the real resolver on :1053/:5381 and checks
 * the cache, rewrites, local records, the new socket pool and the new API endpoints.
 */
const path = require('path');
const fs = require('fs');
const dgram = require('dgram');
const http = require('http');
const { spawn } = require('child_process');
const dnsPacket = require('dns-packet');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, '.smoke-data');
const CONFIG = path.join(DATA, 'config.json');
const DNS_PORT = 1053, WEB_PORT = 5381, FAKE_PORT = 15353, BLOCK_PORT = 18053;
const TOKEN = 'test-token-0123456789abcdef';

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(CONFIG, JSON.stringify({
  dns: { host: '127.0.0.1', host6: false, port: DNS_PORT, tcp: false, ednsUdpSize: 1232 },
  web: { host: '127.0.0.1', port: WEB_PORT, apiToken: TOKEN },
  upstreams: [{ name: 'fake', address: '127.0.0.1', port: FAKE_PORT }],
  workers: 1, dot: false, doh: false, blockPagePort: BLOCK_PORT,
  cache: { maxEntries: 2000, maxHeapMB: 64, minTtl: 1, maxTtl: 3600, negMaxTtl: 60, serveStale: true, serveStaleMaxAge: 3600, prefetch: false, prefetchWindow: 5, snapshotIntervalSec: 300 },
  log: { ringSize: 500, file: false, maxFileBytes: 1048576, keepFiles: 1 },
  blocklists: [], blockAllowlist: [], blockedResponse: 'nxdomain',
  localRecords: [{ name: 'printer.lan', type: 'A', data: '10.0.0.9', ttl: 60 }],
  internalZones: ['lan'], internalFallback: false,
  categories: { steam: { enabled: true, target: '10.0.0.5', target6: '', domains: ['lancache.steamcontent.com'] } },
  clientAcl: [], rateLimitPerClientQps: 0, subnetPolicies: [], conditionalForwarders: [], reverseForwarders: [],
  dnssec: 'passthrough', rebindingProtection: true, dnsCookies: true, caseRandomization: true, dohCanaryNxdomain: true,
  blocklistRefreshHours: 24
}, null, 2));

// ---------------------------------------------------------------- fake upstream
let upstreamQueries = 0;
const fake = dgram.createSocket('udp4');
fake.on('message', (msg, rinfo) => {
  upstreamQueries++;
  let q;
  try { q = dnsPacket.decode(msg); } catch { return; }
  const question = q.questions[0];
  const name = question.name.toLowerCase();
  const base = { type: 'response', id: q.id, flags: dnsPacket.RECURSION_DESIRED | dnsPacket.RECURSION_AVAILABLE, questions: q.questions };
  let answers = [], rcode = 'NOERROR';
  if (name.endsWith('.nx.test')) rcode = 'NXDOMAIN';
  else if (question.type === 'AAAA') answers = [];
  else answers = [{ name, type: 'A', ttl: 60, data: '1.2.3.4' }];
  const out = dnsPacket.encode({ ...base, flags: base.flags | (rcode === 'NXDOMAIN' ? 3 : 0), answers });
  fake.send(out, rinfo.port, rinfo.address);
});
fake.bind(FAKE_PORT, '127.0.0.1');

// ---------------------------------------------------------------- client helpers
function query(sock, name, type = 'A') {
  return new Promise((resolve, reject) => {
    const msg = dnsPacket.encode({ type: 'query', id: Math.floor(Math.random() * 65535), flags: dnsPacket.RECURSION_DESIRED, questions: [{ type, name }] });
    const timer = setTimeout(() => reject(new Error('client timeout for ' + name)), 4000);
    const onMsg = reply => {
      let d; try { d = dnsPacket.decode(reply); } catch { return; }
      if (!d.questions || d.questions[0].name.toLowerCase() !== name.toLowerCase()) return;
      clearTimeout(timer); sock.off('message', onMsg); resolve(d);
    };
    sock.on('message', onMsg);
    sock.send(msg, DNS_PORT, '127.0.0.1');
  });
}
function get(p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: WEB_PORT, path: p, headers: { 'x-api-token': TOKEN }, timeout: 4000 }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { resolve({ raw: Buffer.concat(chunks).toString() }); } });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('web timeout')));
  });
}
const wait = ms => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
function check(label, cond, extra) {
  if (cond) { passed++; console.log(`  PASS  ${label}${extra ? ' — ' + extra : ''}`); }
  else { failed++; console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`); }
}

(async () => {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, STELLARDNS_CONFIG: CONFIG, STELLARDNS_DATA: DATA, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  child.stdout.on('data', d => { serverLog += d; });
  child.stderr.on('data', d => { serverLog += d; });

  const sock = dgram.createSocket('udp4');
  try {
    // wait for readiness
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      try { const d = await query(sock, 'warmup.test'); ready = !!d; }
      catch { await wait(250); }
    }
    check('resolver answers after boot', ready);
    if (!ready) throw new Error('never became ready');

    console.log('\n  hot path');
    const t0 = Date.now();
    const N = 400;
    const results = await Promise.all(Array.from({ length: N }, (_, i) => query(sock, `host${i % 40}.example.test`)));
    const ms = Date.now() - t0;
    check(`${N} queries all answered`, results.every(r => (r.answers || []).length === 1));
    console.log(`        ${N} queries in ${ms}ms = ${Math.round(N / (ms / 1000))} q/s (single worker, loopback)`);

    const s1 = await get('/api/stats');
    check('stats expose qps', typeof s1.qps === 'number', 'qps=' + s1.qps);
    check('stats expose hitRate', typeof s1.hitRate === 'number', 'hitRate=' + s1.hitRate);
    check('cache accumulated entries', s1.cacheSize > 0, 'entries=' + s1.cacheSize);
    // 40 unique names across 400 concurrent queries: the first few must miss, the rest hit.
    check('cache absorbed the repeats', s1.stats.cacheHits >= 250 && s1.stats.cacheMiss < 120,
      `hits=${s1.stats.cacheHits} misses=${s1.stats.cacheMiss}`);
    check('no query was served without an answer', s1.stats.servfail === 0, 'servfail=' + s1.stats.servfail);

    console.log('\n  policy');
    const before = upstreamQueries;
    const cached = await query(sock, 'host0.example.test');
    check('repeat query served from cache', (cached.answers || [])[0]?.data === '1.2.3.4' && upstreamQueries === before,
      `upstream delta=${upstreamQueries - before}`);

    const rw = await query(sock, 'lancache.steamcontent.com');
    check('LANCache rewrite answers cache IP', (rw.answers || [])[0]?.data === '10.0.0.5');

    const loc = await query(sock, 'printer.lan');
    check('local record is authoritative', (loc.answers || [])[0]?.data === '10.0.0.9');

    const nx = await query(sock, 'nope.nx.test');
    check('NXDOMAIN passes through', (nx.flags & 0xf) === 3);

    console.log('\n  api');
    const res = await get('/api/resolve?name=example.test&type=A');
    check('GET /api/resolve returns an answer', res.rcode === 'NOERROR' && (res.answers || []).length === 1, `${res.rcode} ${res.ms}ms`);
    const res2 = await get('/api/resolve?name=printer.lan&type=A');
    check('/api/resolve sees local records', (res2.answers || [])[0]?.data === '10.0.0.9');

    const log = await get('/api/log?n=5');
    check('query log records protocol', Array.isArray(log) && log.every(e => e.proto), 'proto=' + (log[0] && log[0].proto));
    check('/api/resolve does not pollute the log', !log.some(e => e.proto === 'api'));

    const m = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: WEB_PORT, path: '/api/metrics', headers: { 'x-api-token': TOKEN } }, r => {
        let b = ''; r.on('data', c => b += c); r.on('end', () => resolve(b));
      }).on('error', reject);
    });
    check('prometheus metrics render', m.includes('stellardns_queries_total'));
  } catch (e) {
    failed++;
    console.log('  ERROR ' + e.message);
  } finally {
    sock.close();
    child.kill('SIGTERM');
    fake.close();
    await wait(300);
    if (failed) { console.log('\n--- server log (tail) ---\n' + serverLog.split('\n').slice(-25).join('\n')); }
    console.log(`\n  ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
