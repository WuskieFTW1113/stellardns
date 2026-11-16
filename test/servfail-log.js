'use strict';
/* One-off check: a handler failure must produce SERVFAIL (not silence) and a log line that
 * names the query, in both the console log and stderr. The entry below is deliberately
 * unencodable (its rdata is an object, not a Buffer), which is the shape that used to throw. */
const path = require('path');
const fs = require('fs');
const dgram = require('dgram');
const http = require('http');
const { spawn } = require('child_process');
const dnsPacket = require('dns-packet');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, '.servfail-data');
const DNS_PORT = 1057, WEB_PORT = 5387;
const TOKEN = 'servfail-token-0123456789';
const QNAME = 'broken.example.com';

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({
  dns: { host: '127.0.0.1', host6: false, port: DNS_PORT, tcp: false, ednsUdpSize: 1232 },
  web: { host: '127.0.0.1', port: WEB_PORT, apiToken: TOKEN },
  upstreams: [{ name: 'blackhole', address: '127.0.0.1', port: 9 }],
  workers: 1, dot: false, doh: false,
  cache: { maxEntries: 10, maxHeapMB: 32, minTtl: 1, maxTtl: 3600, negMaxTtl: 60, serveStale: false, serveStaleMaxAge: 60, prefetch: false, prefetchWindow: 5, snapshotIntervalSec: 300 },
  log: { ringSize: 50, file: false, maxFileBytes: 1048576, keepFiles: 1 },
  blocklists: [], blockAllowlist: [], blockedResponse: 'nxdomain',
  localRecords: [], internalZones: [], categories: {},
  clientAcl: [], rateLimitPerClientQps: 0, conditionalForwarders: [], reverseForwarders: [],
  dnssec: 'passthrough', rebindingProtection: false, dnsCookies: false, caseRandomization: false,
  blocklistRefreshHours: 24
}, null, 2));
fs.writeFileSync(path.join(DATA, 'cache.snapshot.json'), JSON.stringify([[
  `${QNAME}|UNKNOWN_65`, 'NOERROR',
  [{ name: QNAME, type: 'UNKNOWN_65', ttl: 60, class: 'IN', data: { type: 'Buffer', data: { bad: true } } }],
  Date.now() + 600000, 0, 0
]]));

const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, STELLARDNS_CONFIG: path.join(DATA, 'config.json'), STELLARDNS_DATA: DATA },
  stdio: ['ignore', 'pipe', 'pipe']
});
let log = '';
child.stdout.on('data', d => { log += d; });
child.stderr.on('data', d => { log += d; });

const get = p => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: WEB_PORT, path: p, headers: { 'x-api-token': TOKEN }, timeout: 3000 }, res => {
    let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({}); } });
  }).on('error', reject);
});

function ask() {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const q = dnsPacket.encode({ type: 'query', id: 0x2222, flags: dnsPacket.RECURSION_DESIRED, questions: [{ type: 'UNKNOWN_65', name: QNAME }] });
    const timer = setTimeout(() => { sock.close(); reject(new Error('no response')); }, 3000);
    sock.on('message', m => { clearTimeout(timer); sock.close(); resolve(dnsPacket.decode(m)); });
    sock.send(q, DNS_PORT, '127.0.0.1');
  });
}

(async () => {
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { try { await get('/api/whoami'); up = true; } catch { await new Promise(r => setTimeout(r, 250)); } }
  if (!up) { console.log('server did not start\n' + log); child.kill(); process.exit(1); }

  const resp = await ask().catch(e => ({ error: e.message }));
  const rcode = resp.error ? 'no response' : resp.flags & 0xf;
  console.log('  response rcode:', rcode, '(2 = SERVFAIL)');

  const entries = await get('/api/log?n=10');
  const hit = (Array.isArray(entries) ? entries : []).find(e => e.name === QNAME && e.type === 'UNKNOWN_65');
  console.log('  console log entry:', hit ? JSON.stringify({ name: hit.name, type: hit.type, rcode: hit.rcode, disp: hit.disp }) : 'MISSING');
  console.log('  stderr has name+type:', /SERVFAIL broken\.example\.com UNKNOWN_65/.test(log));

  const ok = rcode === 2 && hit && hit.rcode === 'SERVFAIL' && String(hit.disp).startsWith('handler-error') &&
    /SERVFAIL broken\.example\.com UNKNOWN_65/.test(log);
  child.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(ok ? '  PASS' : '  FAIL');
  process.exit(ok ? 0 : 1);
})();
