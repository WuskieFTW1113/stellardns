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
function post(p, body = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: WEB_PORT, path: p, method: 'POST',
      headers: { 'x-api-token': TOKEN, 'content-type': 'application/json' }, timeout: 4000 }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { resolve({}); } });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('web timeout')));
    req.end(JSON.stringify(body));
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

    // The console's Flush cache button posts here. Clearing one worker is not a flush when
    // workers:0 runs one per core, and a restart reloads the snapshot — so this must actually
    // empty the cache and force the next query upstream.
    const missesBefore = (await get('/api/stats')).stats.cacheMiss;
    const flushed = await post('/api/flush');
    await query(sock, 'host0.example.test');
    const missesAfter = (await get('/api/stats')).stats.cacheMiss;
    check('/api/flush empties the cache', flushed.flushed >= 1 && missesAfter === missesBefore + 1,
      `flushed=${flushed.flushed} misses ${missesBefore} -> ${missesAfter}`);

    // Publish now must make Apple's discovery TXT authoritative immediately, with the short
    // TTL that lets a changed range reach devices in minutes rather than three hours.
    const apple = await post('/api/gen/apple-cache', { zone: 'lan', publicRanges: '203.0.113.0/24', localRanges: '10.0.0.0/24', apply: true });
    const recs = await get('/api/localrecords');
    const appleRec = (Array.isArray(recs) ? recs : []).find(r => r.name === '_aaplcache._tcp.lan' && r.type === 'TXT');
    const appleAns = await query(sock, '_aaplcache._tcp.lan', 'TXT');
    const txtData = ((appleAns.answers || [])[0]?.data || []).map(x => Buffer.isBuffer(x) ? x.toString() : String(x)).join('');
    // Apple's documented human-readable format is single addresses or start-end ranges;
    // CIDR input is converted, and the stored/effective TTLs still reach devices in minutes.
    check('Apple discovery TXT is published in Apple range format', apple.applied === true && !!appleRec &&
      appleRec.ttl === 300 && (appleAns.answers || [])[0]?.ttl <= 300 && !/fss is empty/.test(apple.hint) &&
      ['prs=203.0.113.0-203.0.113.255', 'fss=10.0.0.0-10.0.0.255'].every(s => txtData.includes(s)),
      `stored=${appleRec?.ttl} effective=${(appleAns.answers || [])[0]?.ttl} txt=${txtData}`);

    const noFss = await post('/api/gen/apple-cache', { zone: 'lan', publicRanges: '203.0.113.0/24' });
    check('Apple publisher warns when fss is empty', /fss is empty/.test(noFss.hint) && !noFss.records[0].data.includes('fss='),
      noFss.hint);

    const literal = await post('/api/gen/apple-cache', { zone: 'lan', publicRanges: '203.0.113.10', localRanges: '10.0.0.30,10.1.0.30-10.1.0.40' });
    check('Apple publisher accepts single addresses and start-end ranges', literal.records?.[0]?.data === 'prs=203.0.113.10 fss=10.0.0.30,10.1.0.30-10.1.0.40',
      literal.records?.[0]?.data);

    // CIDR boundaries: /32 collapses to one address, /31 covers both, host bits are
    // masked to the network, and the top of the address space stays unsigned.
    for (const [cidr, expected] of [
      ['10.0.0.5/32', '10.0.0.5'],
      ['10.0.0.4/31', '10.0.0.4-10.0.0.5'],
      ['203.0.113.10/24', '203.0.113.0-203.0.113.255'],
      ['128.0.0.0/1', '128.0.0.0-255.255.255.255'],
      ['0.0.0.0/0', '0.0.0.0-255.255.255.255'],
      ['255.255.255.255/32', '255.255.255.255']
    ]) {
      const r = await post('/api/gen/apple-cache', { zone: 'lan', publicRanges: cidr, localRanges: '10.0.0.0/24' });
      check(`Apple CIDR ${cidr} -> ${expected}`, r.records?.[0]?.data?.startsWith(`prs=${expected} `), r.records?.[0]?.data);
    }

    for (const cidr of ['10.0.0.0/', '10.0.0.0/24/8', '300.1.1.1/24']) {
      const r = await post('/api/gen/apple-cache', { zone: 'lan', publicRanges: cidr, localRanges: '10.0.0.0/24' });
      check(`Apple CIDR rejects ${cidr}`, /^Malformed Apple cache range: prs=/.test(r.error || ''), r.error);
    }

    const badPrs = await post('/api/gen/apple-cache', { zone: 'lan', publicRanges: '10.0.0.0/33', localRanges: '10.0.0.0/24' });
    check('Apple publisher rejects a malformed prs range', /^Malformed Apple cache range: prs="10\.0\.0\.0\/33"/.test(badPrs.error || ''),
      badPrs.error);

    const badFss = await post('/api/gen/apple-cache', { zone: 'lan', publicRanges: '203.0.113.0/24', localRanges: '10.0.0.10-10.0.0.1' });
    check('Apple publisher rejects a reversed fss range', /^Malformed Apple cache range: fss="10\.0\.0\.10-10\.0\.0\.1"/.test(badFss.error || ''),
      badFss.error);

    // Validation must run before apply: a typo must never replace a working record.
    const badApply = await post('/api/gen/apple-cache', { zone: 'lan', publicRanges: 'not-a-range', localRanges: '10.0.0.0/24', apply: true });
    const recsAfterBad = await get('/api/localrecords');
    const keptRec = (Array.isArray(recsAfterBad) ? recsAfterBad : []).find(r => r.name === '_aaplcache._tcp.lan' && r.type === 'TXT');
    check('Malformed ranges never replace the published record', !!badApply.error && !!keptRec && keptRec.data.includes('prs=203.0.113.0-203.0.113.255'),
      keptRec?.data);

    const multi = await post('/api/gen/apple-cache', { zone: 'lan', publicRanges: '203.0.113.0/24, 203.0.114.0/24', localRanges: '10.0.0.0/24' });
    check('Apple publisher normalizes comma-separated ranges', multi.records?.[0]?.data === 'prs=203.0.113.0-203.0.113.255,203.0.114.0-203.0.114.255 fss=10.0.0.0-10.0.0.255',
      multi.records?.[0]?.data);

    const noRanges = await post('/api/gen/apple-cache', { zone: 'lan' });
    check('Apple publisher requires at least one range', /at least one public or local range/.test(noRanges.error || ''), noRanges.error);
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
