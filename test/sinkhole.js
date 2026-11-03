'use strict';
/* Verifies the stealth sinkhole is zero-config, shape-correct and not a fingerprint:
 *   - a blocked A query is answered with this host's own LAN address (no sinkholeIP set)
 *   - <img> beacons get a real GIF, not HTML
 *   - JSON beacons get JSON that parses, with CORS that survives credentials
 *   - script and preflight requests work
 *   - the stub answers only names that are actually blocked
 *   - a blocked AAAA without a v6 sinkhole is NODATA, not NXDOMAIN
 *   - TTLs differ between names but are stable for one name
 *   - nothing in the responses mentions blocking
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const dgram = require('dgram');
const { spawn } = require('child_process');
const dnsPacket = require('dns-packet');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, '.sinkhole-data');
const DNS_PORT = 1073, WEB_PORT = 5392, LIST_PORT = 15410, STUB_PORT = 18073, FAKE_PORT = 15411;
const TOKEN = 'sinkhole-token-0123456789';
const BLOCKED = ['ads.test', 'tracker.test', 'pixel.test', 'metrics.test', 'beacon.test', 'promo.test'];

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });

// blocklist served locally so the test does not need the internet
const listSrv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(BLOCKED.join('\n') + '\n'); });
listSrv.listen(LIST_PORT, '127.0.0.1');

fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({
  dns: { host: '127.0.0.1', host6: false, port: DNS_PORT, tcp: false, ednsUdpSize: 1232 },
  web: { host: '127.0.0.1', port: WEB_PORT, apiToken: TOKEN },
  upstreams: [{ name: 'fake', address: '127.0.0.1', port: FAKE_PORT }],
  workers: 1, dot: false, doh: false, blockPagePort: STUB_PORT,
  cache: { maxEntries: 500, maxHeapMB: 32, minTtl: 1, maxTtl: 60, negMaxTtl: 30, serveStale: false, serveStaleMaxAge: 60, prefetch: false, prefetchWindow: 5, snapshotIntervalSec: 300 },
  log: { ringSize: 50, file: false, maxFileBytes: 1048576, keepFiles: 1 },
  blocklists: [{ name: 'local', url: `http://127.0.0.1:${LIST_PORT}/list.txt`, enabled: true }],
  blockAllowlist: [], blockedResponse: 'sinkhole',
  sinkholeIP: '', sinkholeIPv6: '',              // deliberately empty: must auto-detect
  localRecords: [], internalZones: [], categories: {},
  clientAcl: [], rateLimitPerClientQps: 0, subnetPolicies: [], conditionalForwarders: [], reverseForwarders: [],
  dnssec: 'passthrough', rebindingProtection: true, dnsCookies: false, caseRandomization: false,
  blocklistRefreshHours: 24
}, null, 2));

// upstream that answers everything, so a blocklist miss is visible as a normal answer
const fake = dgram.createSocket('udp4');
fake.on('message', (msg, rinfo) => {
  let q; try { q = dnsPacket.decode(msg); } catch { return; }
  const name = q.questions[0].name.toLowerCase();
  const out = dnsPacket.encode({
    type: 'response', id: q.id, flags: dnsPacket.RECURSION_DESIRED | dnsPacket.RECURSION_AVAILABLE,
    questions: q.questions, answers: [{ name, type: 'A', ttl: 60, data: '203.0.113.9' }]
  });
  fake.send(out, rinfo.port, rinfo.address);
});
fake.bind(FAKE_PORT, '127.0.0.1');

const get = (p) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: WEB_PORT, path: p, headers: { 'x-api-token': TOKEN } },
    res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); });
  req.on('error', reject); req.end();
});

// `headers.host` is the HTTP Host header — the gateway's own name is how a client that has
// already resolved a blocked domain reaches the stub.
function fetchStub(opts) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: STUB_PORT, ...opts }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
}

async function main() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: { ...process.env, STELLARDNS_CONFIG: path.join(DATA, 'config.json'), STELLARDNS_DATA: DATA },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  const die = (m) => { console.error('  FAIL  ' + m); console.error(log.split('\n').slice(-10).join('\n')); try { child.kill(); } catch {} process.exit(1); };

  let up = false;
  for (let i = 0; i < 40 && !up; i++) { try { await get('/api/whoami'); up = true; } catch { await new Promise(r => setTimeout(r, 250)); } }
  if (!up) die('server did not start');

  let fails = 0;
  const check = (name, ok, detail) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!ok) fails++; };

  await new Promise(r => setTimeout(r, 1500));   // let the blocklist load

  // 1) zero-config DNS answer
  const r = await get('/api/resolve?name=ads.test&type=A');
  const ip = (r.answers || [])[0] && r.answers[0].data;
  const isPrivate = !!ip && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  check('blocked name answered with a real address, no sinkholeIP configured', r.rcode === 'NOERROR' && isPrivate, `${r.rcode} ${ip}`);

  // 2) an unblocked name still resolves normally
  const r2 = await get('/api/resolve?name=example.test&type=A');
  check('unblocked name still resolves upstream', (r2.answers || [])[0]?.data === '203.0.113.9', `${(r2.answers || [])[0]?.data}`);

  // 3) image beacon gets a decodable GIF
  const img = await fetchStub({ path: '/pixel.gif', method: 'GET', headers: { host: 'ads.test', accept: 'image/webp,*/*' } });
  const gifOk = img.body.subarray(0, 6).toString() === 'GIF89a' || img.body.subarray(0, 6).toString() === 'GIF87a';
  check('image beacon returns a real GIF', img.status === 200 && gifOk, `${img.status} ${img.headers['content-type']} ${img.body.length}B`);

  // 4) JSON beacon parses and is CORS-usable with credentials
  const js = await fetchStub({ path: '/collect?e=1', method: 'POST', headers: { host: 'ads.test', accept: 'application/json', origin: 'https://news.example' } });
  let parsed = null; try { parsed = JSON.parse(js.body.toString()); } catch {}
  const corsOk = js.headers['access-control-allow-origin'] === 'https://news.example' &&
                 js.headers['access-control-allow-credentials'] === 'true';
  check('JSON beacon parses with credentialed CORS', js.status === 200 && !!parsed && corsOk, `${js.status} acao=${js.headers['access-control-allow-origin']}`);

  // 5) script beacon is valid JS, not HTML
  const sc = await fetchStub({ path: '/tag.js', method: 'GET', headers: { host: 'ads.test', accept: '*/*' } });
  check('script beacon returns javascript', /javascript/.test(sc.headers['content-type'] || '') && sc.status === 200, sc.headers['content-type']);

  // 6) preflight
  const pf = await fetchStub({ path: '/collect', method: 'OPTIONS', headers: { host: 'ads.test', origin: 'https://news.example', 'access-control-request-headers': 'content-type,x-custom' } });
  check('preflight returns 204 with echoed headers', pf.status === 204 && /x-custom/.test(pf.headers['access-control-allow-headers'] || ''), `${pf.status}`);

  // 7) the stub is not an open oracle: a name that is not blocked gets a plain 404
  const nb = await fetchStub({ path: '/collect?e=1', method: 'GET', headers: { host: 'shop.example', accept: 'application/json' } });
  check('stub refuses names that are not blocked', nb.status === 404 && !/ads|impression/.test(nb.body.toString()), `${nb.status} ${nb.body.length}B`);

  // 8) a blocked AAAA with no sinkholeIPv6 is NODATA, not NXDOMAIN
  const v6 = await get('/api/resolve?name=ads.test&type=AAAA');
  check('blocked AAAA without a v6 sinkhole is NODATA', v6.rcode === 'NOERROR' && (v6.answers || []).length === 0, `${v6.rcode} ${(v6.answers || []).length} answers`);

  // 9) TTL is not a constant: distinct per name, stable for one name
  const ttls = [];
  for (const n of BLOCKED) { const x = await get(`/api/resolve?name=${n}&type=A`); ttls.push((x.answers || [])[0]?.ttl); }
  const again = ((await get('/api/resolve?name=ads.test&type=A')).answers || [])[0]?.ttl;
  check('per-name TTL differs across domains', new Set(ttls).size > 1, ttls.join(','));
  check('per-name TTL is stable for one domain', again === ttls[0], `${ttls[0]} vs ${again}`);

  // 10) nothing says "blocked"
  const txt = (img.body.toString('latin1') + js.body.toString() + sc.body.toString()).toLowerCase();
  check('no response leaks that it is a block', !txt.includes('blocked') && !txt.includes('stellardns'), `${txt.length} chars scanned`);

  try { child.kill(); } catch {}
  try { fake.close(); } catch {}
  try { listSrv.close(); } catch {}
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(`\n  ${11 - fails} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
}

main().catch(e => { console.error(e); try { fake.close(); listSrv.close(); } catch {} process.exit(1); });
