'use strict';
/* Regression: an HTTPS/SVCB answer cached before a restart must still be served after it.
 *
 * dns-packet 5.x has no HTTPS type, so type 65 is carried as UNKNOWN_65 with raw rdata bytes.
 * The snapshot is JSON, and JSON turns those bytes into {type:'Buffer',data:[...]}; re-encoding
 * that throws, and the query gets no answer at all. iOS queries HTTPS for most modern sites,
 * so the failure looked like "certain websites don't load on the phone" and survived a restart.
 */
const path = require('path');
const fs = require('fs');
const dgram = require('dgram');
const http = require('http');
const { spawn } = require('child_process');
const dnsPacket = require('dns-packet');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, '.snapshot-https-data');
const DNS_PORT = 1056, WEB_PORT = 5386, FAKE_PORT = 15356;
const TOKEN = 'snapshot-token-0123456789';
const QNAME = 'secure.example.com';

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({
  dns: { host: '127.0.0.1', host6: false, port: DNS_PORT, tcp: true, ednsUdpSize: 1232 },
  web: { host: '127.0.0.1', port: WEB_PORT, apiToken: TOKEN },
  upstreams: [{ name: 'fake', address: '127.0.0.1', port: FAKE_PORT }],
  workers: 1, dot: false, doh: false,
  // 1s, not 300: Windows cannot deliver SIGTERM to the child, so the shutdown snapshot never
  // runs there. The interval is the portable way to get a snapshot written before the restart.
  cache: { maxEntries: 100, maxHeapMB: 32, minTtl: 1, maxTtl: 3600, negMaxTtl: 60, serveStale: false, serveStaleMaxAge: 60, prefetch: false, prefetchWindow: 5, snapshotIntervalSec: 1 },
  log: { ringSize: 50, file: false, maxFileBytes: 1048576, keepFiles: 1 },
  blocklists: [], blockAllowlist: [], blockedResponse: 'nxdomain',
  localRecords: [], internalZones: [], categories: {},
  clientAcl: [], rateLimitPerClientQps: 0, conditionalForwarders: [], reverseForwarders: [],
  dnssec: 'passthrough', rebindingProtection: true, dnsCookies: false, caseRandomization: false,
  blocklistRefreshHours: 24
}, null, 2));

function nameWire(n) {
  const parts = n.split('.').map(l => Buffer.concat([Buffer.from([l.length]), Buffer.from(l, 'ascii')]));
  return Buffer.concat([...parts, Buffer.from([0])]);
}
// priority 1, target svc.example.com, key 1 (alpn) = h2
const RDATA = Buffer.concat([
  Buffer.from([0, 1]),
  nameWire('svc.example.com'),
  Buffer.from([0, 1, 0, 2, 2, 0x68, 0x32])
]);

let upstreamQueries = 0;
const fake = dgram.createSocket('udp4');
fake.on('message', (msg, rinfo) => {
  upstreamQueries++;
  let q; try { q = dnsPacket.decode(msg); } catch { return; }
  const question = q.questions[0];
  const answers = question.type === 'UNKNOWN_65'
    ? [{ name: question.name, type: 'UNKNOWN_65', ttl: 60, class: 'IN', data: RDATA }]
    : [{ name: question.name, type: 'A', ttl: 60, class: 'IN', data: '1.2.3.4' }];
  const out = dnsPacket.encode({
    type: 'response', id: q.id,
    flags: dnsPacket.RECURSION_DESIRED | dnsPacket.RECURSION_AVAILABLE,
    questions: q.questions, answers
  });
  fake.send(out, rinfo.port, rinfo.address);
});
fake.bind(FAKE_PORT, '127.0.0.1');

function start() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, STELLARDNS_CONFIG: path.join(DATA, 'config.json'), STELLARDNS_DATA: DATA },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  return { child, log: () => log };
}

const get = p => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: WEB_PORT, path: p, headers: { 'x-api-token': TOKEN }, timeout: 3000 }, res => {
    let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({}); } });
  }).on('error', reject);
});

async function waitUp() {
  for (let i = 0; i < 40; i++) { try { await get('/api/whoami'); return true; } catch { await new Promise(r => setTimeout(r, 250)); } }
  return false;
}

function ask() {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const q = dnsPacket.encode({ type: 'query', id: 0x1234, flags: dnsPacket.RECURSION_DESIRED, questions: [{ type: 'UNKNOWN_65', name: QNAME }] });
    const timer = setTimeout(() => { sock.close(); reject(new Error('no response (timeout)')); }, 3000);
    sock.on('message', m => { clearTimeout(timer); sock.close(); try { resolve(dnsPacket.decode(m)); } catch (e) { reject(e); } });
    sock.send(q, DNS_PORT, '127.0.0.1');
  });
}

(async () => {
  let fails = 0;
  const check = (name, ok, detail) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!ok) fails++; };

  let s = start();
  if (!await waitUp()) { console.log('  server did not start\n' + s.log()); fake.close(); process.exit(1); }

  const first = await ask();
  check('HTTPS answer before restart', (first.answers || [])[0]?.type === 'UNKNOWN_65' && (first.answers || [])[0]?.data.length === RDATA.length,
    `${(first.answers || [])[0]?.data?.length} bytes`);
  const upstreamBefore = upstreamQueries;

  await new Promise(r => setTimeout(r, 1600));   // let the 1s snapshot interval run
  const snap = path.join(DATA, 'cache.snapshot.json');
  check('snapshot written', fs.existsSync(snap));
  s.child.kill();
  await new Promise(r => s.child.on('exit', r));
  check('snapshot stores the rdata as JSON Buffer', fs.existsSync(snap) && fs.readFileSync(snap, 'utf8').includes('"type":"Buffer"'));

  s = start();
  if (!await waitUp()) { console.log('  server did not restart\n' + s.log()); fake.close(); process.exit(1); }
  check('snapshot was restored', s.log().includes('restored') && !s.log().includes('restored 0'));

  const second = await ask().catch(e => ({ error: e.message }));
  check('HTTPS answer after restart', !second.error && (second.answers || [])[0]?.type === 'UNKNOWN_65',
    second.error || `${(second.answers || [])[0]?.data?.length} bytes`);
  check('served from the restored entry, not upstream', upstreamQueries === upstreamBefore,
    `upstream ${upstreamBefore} -> ${upstreamQueries}`);

  s.child.kill();
  await new Promise(r => s.child.on('exit', r));
  fake.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(`\n  ${6 - fails} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
})();
