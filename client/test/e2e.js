'use strict';
/* End-to-end: boots the real resolver and GUI on high ports, with the encrypted transport
 * replaced by a canned answer so filtering, caching and response shape can be asserted
 * without depending on the internet. The last check does use the real DoH transport and is
 * reported as skipped, not failed, when there is no network.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const dgram = require('dgram');

process.env.STELLARDNS_CLIENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sdc-'));

const dnsPacket = require('dns-packet');
const { load } = require('../src/config');
const { Blocklist } = require('../src/blocklist');
const { Resolver, startListeners } = require('../src/proxy');
const gui = require('../src/gui');
const doh = require('../src/doh');

let pass = 0, fail = 0;
const ok = m => { pass++; console.log('  PASS  ' + m); };
const no = m => { fail++; console.log('  FAIL  ' + m); };
const is = (c, m) => c ? ok(m) : no(m);

const NXDOMAIN = 3;
const rcodeOf = buf => buf[3] & 0x0f;

function answerFor(query) {
  const q = dnsPacket.decode(query);
  return dnsPacket.encode({
    type: 'response', id: q.id,
    flags: dnsPacket.RECURSION_DESIRED | dnsPacket.RECURSION_AVAILABLE,
    questions: q.questions,
    answers: [{ name: q.questions[0].name, type: 'A', ttl: 120, class: 'IN', data: '93.184.216.34' }]
  });
}

function askUdp(port, name, type = 'A') {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    const q = dnsPacket.encode({ type: 'query', id: 4321, flags: dnsPacket.RECURSION_DESIRED, questions: [{ type, name }] });
    const t = setTimeout(() => { s.close(); reject(new Error('timeout')); }, 5000);
    s.once('message', m => { clearTimeout(t); s.close(); resolve(m); });
    s.send(q, port, '127.0.0.1');
  });
}

function httpGet(port, p, host) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, headers: { host: host || `127.0.0.1:${port}` } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(body); } catch {}
        resolve({ status: res.statusCode, json, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function httpJson(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body || {}));
    const req = http.request({ host: '127.0.0.1', port, path: p, method,
      headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', 'content-length': payload.length } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, body: text });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

(async () => {
  const cfg = load();
  cfg.listen = { host: '127.0.0.1', port: 5399 };
  cfg.gui = { host: '127.0.0.1', port: 5398 };
  cfg.allowlist = ['allowed.ads.example.com'];

  const list = new Blocklist();
  list.add('ads.example.com');
  list.add('tracker.example.net');
  list.setAllowlist(cfg.allowlist);

  const resolver = new Resolver(cfg, list);
  let forwarded = 0;
  resolver.forward = async msg => { forwarded++; await new Promise(r => setTimeout(r, 40)); return answerFor(msg); };

  // The DNS prompt must never repoint this machine during a test run.
  const fakeDns = {
    applied: 0, restored: 0,
    apply() { this.applied++; return { platform: 'test', iface: 'eth0', before: '1.1.1.1', elevated: false }; },
    restore() { this.restored++; return { restored: true }; }
  };

  const listeners = await startListeners(resolver, cfg);
  const server = await gui.start(resolver, cfg, { sysdns: fakeDns });

  // --- filtering -----------------------------------------------------------
  const blocked = dnsPacket.decode(await askUdp(5399, 'ads.example.com'));
  is(blocked.rcode === 'NXDOMAIN' && (blocked.answers || []).length === 0, 'blocked name answers NXDOMAIN with no answers');
  is(rcodeOf(await askUdp(5399, 'ads.example.com')) === NXDOMAIN, 'blocked parent answers NXDOMAIN on the wire');
  is(rcodeOf(await askUdp(5399, 'sub.ads.example.com')) === NXDOMAIN, 'subdomain of a blocked name is blocked');
  const allowed = dnsPacket.decode(await askUdp(5399, 'allowed.ads.example.com'));
  is((allowed.answers || [])[0] && allowed.answers[0].data === '93.184.216.34', 'allowlist overrides the blocked parent');

  // --- cache ---------------------------------------------------------------
  const before = forwarded;
  const r1 = dnsPacket.decode(await askUdp(5399, 'example.com'));
  const r2 = dnsPacket.decode(await askUdp(5399, 'example.com'));
  is(r1.answers[0].data === '93.184.216.34' && r2.answers[0].data === '93.184.216.34', 'allowed name resolves');
  is(forwarded === before + 1, 'second identical query came from cache, not upstream');

  await new Promise(r => setTimeout(r, 1100));
  const aged = dnsPacket.decode(await askUdp(5399, 'example.com'));
  is(aged.answers[0].ttl < r1.answers[0].ttl, 'cached answers age their TTL');

  // --- GUI -----------------------------------------------------------------
  const state = await httpGet(5398, '/api/state');
  is(state.status === 200 && state.json.running === true, 'GUI /api/state answers');
  is(state.json.blocklist.entries === 2, 'GUI reports the loaded blocklist size');
  is(state.json.stats.cacheHits >= 1, 'GUI reports the cache hit');

  const test = await httpGet(5398, '/api/test?name=tracker.example.net&type=A');
  is(test.status === 200 && test.json.rcode === 'NXDOMAIN', 'GUI test endpoint shows the block');

  const rebound = await httpGet(5398, '/api/state', 'evil.example.com');
  is(rebound.status === 403, 'GUI rejects a non-loopback Host header');

  // The Host check is not enough on its own: a page the user visits supplies the loopback Host
  // itself when it POSTs here, so a cross-site write used to be accepted. These three fix that
  // behaviour in place — a foreign Origin, a body a no-cors request could actually send, and the
  // ordinary same-origin case that has to keep working.
  const postToggle = (origin, contentType) => new Promise(resolve => {
    const payload = Buffer.from(JSON.stringify({ blocking: false }));
    const req = http.request({
      host: '127.0.0.1', port: 5398, path: '/api/toggle', method: 'POST',
      headers: {
        host: '127.0.0.1:5398', 'content-type': contentType,
        'content-length': payload.length, ...(origin ? { origin } : {})
      }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', e => resolve({ status: 0, body: e.message }));
    req.write(payload);
    req.end();
  });

  const crossSite = await postToggle('http://evil.example', 'text/plain');
  is(crossSite.status === 403 && cfg.blockingEnabled !== false, 'GUI refuses a write from a foreign Origin');
  const plainPost = await postToggle(null, 'text/plain');
  is(plainPost.status === 415, 'GUI refuses a non-JSON body a cross-site form could send');
  const jsonPost = await postToggle('http://127.0.0.1:5398', 'application/json');
  is(jsonPost.status === 200 && cfg.blockingEnabled === false, 'GUI still accepts a same-origin JSON write');
  cfg.blockingEnabled = true; resolver.blocking = true;

  const page = await httpGet(5398, '/');
  is(page.status === 200 && /StellarDNS/.test(page.body), 'GUI serves its page');

  // --- first-run DNS prompt ------------------------------------------------
  const fresh = await httpGet(5398, '/api/state');
  is(fresh.json.dns && fresh.json.dns.prompt === true, 'first run offers to manage system DNS');
  is(fresh.json.dns.canApply === false, 'the prompt knows the client is not on port 53 yet');

  const refused = await httpJson(5398, 'POST', '/api/dns/apply', {});
  is(refused.status === 400 && /port 53/.test(refused.json.error || ''), 'takeover is refused while the client is not on port 53');
  is(fakeDns.applied === 0, 'refusing left the resolver alone');

  cfg.listen.port = 53;   // the port a real client answers on
  const applied = await httpJson(5398, 'POST', '/api/dns/apply', {});
  is(applied.status === 200 && applied.json.ok === true, 'accepting the prompt points the OS at the client');
  is(cfg.setSystemDns === true && cfg.systemDnsBackup && cfg.systemDnsBackup.before === '1.1.1.1',
    'the previous resolver is saved before the change');
  is(fakeDns.applied === 1, 'the platform DNS command ran exactly once');

  const managed = await httpGet(5398, '/api/state');
  is(managed.json.dns.prompt === false && managed.json.dns.managed === true, 'the prompt stays gone once DNS is managed');

  const restored = await httpJson(5398, 'POST', '/api/dns/restore', {});
  is(restored.status === 200 && cfg.setSystemDns === false && !cfg.systemDnsBackup, 'restoring clears the managed state');
  is(fakeDns.restored === 1, 'restoring runs the platform restore');

  cfg.dnsPromptShown = false;
  const dismissed = await httpJson(5398, 'POST', '/api/dns/dismiss', {});
  is(dismissed.status === 200 && (await httpGet(5398, '/api/state')).json.dns.prompt === false,
    'declining the prompt does not ask again');

  // --- transport -----------------------------------------------------------
  try {
    const q = dnsPacket.encode({ type: 'query', id: 99, flags: dnsPacket.RECURSION_DESIRED, questions: [{ type: 'A', name: 'example.com' }] });
    const out = await doh.dohQuery({ name: 'cloudflare', hostname: 'cloudflare-dns.com', path: '/dns-query' }, q, 8000);
    const dec = dnsPacket.decode(out);
    is(dec.rcode === 'NOERROR' && (dec.answers || []).length > 0, 'live DoH query returns a real answer');
  } catch (e) {
    console.log('  SKIP  live DoH (' + e.message + ')');
  }

  listeners.close();
  server.close();

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('  FAIL  ' + e.message); console.error(e.stack); process.exit(1); });
