'use strict';
/* Two regressions this file exists to catch:
 *   1. Hedging — a forwarder that is alive but slow must not add its full latency to every
 *      query. The slow forwarder here waits 1200ms; with hedging the fast one (started after
 *      hedgeDelayMs) answers in well under a second.
 *   2. Duplicate RRs — an upstream that returns the same A record twice must produce one
 *      answer, because mDNS/Bonjour clients read duplicates as an address conflict and
 *      rename themselves.
 */
const path = require('path');
const fs = require('fs');
const dgram = require('dgram');
const { spawn } = require('child_process');
const dnsPacket = require('dns-packet');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, '.fastpath-data');
const DNS_PORT = 1063, WEB_PORT = 5382, SLOW_PORT = 15401, FAST_PORT = 15402, BLOCK_PORT = 18063;
const TOKEN = 'fastpath-token-0123456789';
const SLOW_DELAY = 1200;

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({
  dns: { host: '127.0.0.1', host6: false, port: DNS_PORT, tcp: false, ednsUdpSize: 1232 },
  web: { host: '127.0.0.1', port: WEB_PORT, apiToken: TOKEN },
  upstreams: [
    { name: 'slow', address: '127.0.0.1', port: SLOW_PORT },   // first by insertion, equal SRTT
    { name: 'fast', address: '127.0.0.1', port: FAST_PORT }
  ],
  workers: 1, dot: false, doh: false, blockPagePort: BLOCK_PORT,
  cache: { maxEntries: 2000, maxHeapMB: 64, minTtl: 1, maxTtl: 3600, negMaxTtl: 60, serveStale: true, serveStaleMaxAge: 3600, prefetch: false, prefetchWindow: 5, snapshotIntervalSec: 300 },
  log: { ringSize: 100, file: false, maxFileBytes: 1048576, keepFiles: 1 },
  blocklists: [], blockAllowlist: [], blockedResponse: 'nxdomain',
  localRecords: [], internalZones: [], categories: {},
  clientAcl: [], rateLimitPerClientQps: 0, subnetPolicies: [], conditionalForwarders: [], reverseForwarders: [],
  dnssec: 'passthrough', rebindingProtection: true, dnsCookies: false, caseRandomization: false,
  hedge: true, hedgeDelayMs: 60, blocklistRefreshHours: 24
}, null, 2));

function fakeUpstream(port, delayMs) {
  const sock = dgram.createSocket('udp4');
  sock.on('message', (msg, rinfo) => {
    let q;
    try { q = dnsPacket.decode(msg); } catch { return; }
    const name = q.questions[0].name.toLowerCase();
    const answers = [];
    if (name === 'dup.test') {
      answers.push({ name, type: 'A', ttl: 60, data: '5.5.5.5' });
      answers.push({ name, type: 'A', ttl: 60, data: '5.5.5.5' });   // exact duplicate
    } else {
      answers.push({ name, type: 'A', ttl: 60, data: '9.9.9.9' });
    }
    const out = dnsPacket.encode({
      type: 'response', id: q.id,
      flags: dnsPacket.RECURSION_DESIRED | dnsPacket.RECURSION_AVAILABLE,
      questions: q.questions, answers
    });
    const send = () => sock.send(out, rinfo.port, rinfo.address);
    if (delayMs) setTimeout(send, delayMs); else send();
  });
  sock.bind(port, '127.0.0.1');
  return sock;
}

const slow = fakeUpstream(SLOW_PORT, SLOW_DELAY);
const fast = fakeUpstream(FAST_PORT, 0);

const get = (p) => new Promise((resolve, reject) => {
  const req = require('http').request({ host: '127.0.0.1', port: WEB_PORT, path: p, headers: { 'x-api-token': TOKEN } },
    res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); });
  req.on('error', reject); req.end();
});

async function main() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: { ...process.env, STELLARDNS_CONFIG: path.join(DATA, 'config.json'), STELLARDNS_DATA: DATA },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });

  const cleanup = () => { try { child.kill(); } catch {} try { slow.close(); } catch {} try { fast.close(); } catch {} };
  const fail = (m) => { console.error('  FAIL  ' + m); console.error(log.split('\n').slice(-8).join('\n')); cleanup(); process.exit(1); };

  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try { await get('/api/whoami'); up = true; } catch { await new Promise(r => setTimeout(r, 250)); }
  }
  if (!up) fail('server did not start');

  let fails = 0;
  const check = (name, ok, detail) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!ok) fails++; };

  // 1) hedging: slow forwarder is first, so a sequential resolver would take ~1200ms
  let t0 = Date.now();
  const r1 = await get('/api/resolve?name=hedge.test&type=A');
  const ms = Date.now() - t0;
  check('answers while the primary forwarder is silent', r1.rcode === 'NOERROR' && (r1.answers || []).length === 1, `${r1.rcode} ${ms}ms`);
  check(`hedged around the ${SLOW_DELAY}ms forwarder`, ms < SLOW_DELAY / 2, `${ms}ms < ${SLOW_DELAY / 2}ms`);

  // 2) duplicate RRs collapse to one answer
  const r2 = await get('/api/resolve?name=dup.test&type=A');
  check('duplicate A records collapsed', (r2.answers || []).length === 1, `${(r2.answers || []).length} answer(s)`);

  // 3) the fast path still caches (second lookup must not go upstream again)
  const before = (await get('/api/stats')).stats.cacheMiss;
  await get('/api/resolve?name=hedge.test&type=A');
  const after = (await get('/api/stats')).stats.cacheMiss;
  check('repeat lookup served from cache', after === before, `misses ${before} -> ${after}`);

  cleanup();
  console.log(`\n  ${3 - fails} passed, ${fails} failed`);
  fs.rmSync(DATA, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
}

main().catch(e => { console.error(e); try { slow.close(); fast.close(); } catch {} process.exit(1); });
