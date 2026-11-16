'use strict';
/* Rule import, end to end against the real server code.
 * Boots server.js with one enabled and one disabled category, then exercises discovery, auth,
 * selection, the rewrite path and the GUI's import endpoints.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const dgram = require('dgram');

process.env.STELLARDNS_CLIENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sdc-import-'));

const dnsPacket = require('dns-packet');
const { load } = require('../src/config');
const { Blocklist } = require('../src/blocklist');
const { Resolver, startListeners } = require('../src/proxy');
const rules = require('../src/rules');
const discover = require('../src/discover');
const gui = require('../src/gui');

const repo = path.join(__dirname, '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sds-'));
const cfgPath = path.join(tmp, 'config.json');
const TOKEN = 'import-test-token';
const WEB_PORT = 5389;
const DNS_PORT = 5392;
const CLIENT_DNS = 5395;
const CLIENT_GUI = 5397;

let pass = 0, fail = 0;
const ok = m => { pass++; console.log('  PASS  ' + m); };
const no = m => { fail++; console.log('  FAIL  ' + m); };
const is = (c, m) => c ? ok(m) : no(m);

function httpJson(port, method, p, body, host) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, path: p, method,
      headers: { host: host || `127.0.0.1:${port}`, 'content-type': 'application/json', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function askUdp(port, name, type = 'A') {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    const q = dnsPacket.encode({ type: 'query', id: 7, flags: dnsPacket.RECURSION_DESIRED, questions: [{ type, name }] });
    const t = setTimeout(() => { s.close(); reject(new Error('timeout')); }, 5000);
    s.once('message', m => { clearTimeout(t); s.close(); resolve(dnsPacket.decode(m)); });
    s.send(q, port, '127.0.0.1');
  });
}

async function waitFor(fn, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

(async () => {
  const example = JSON.parse(fs.readFileSync(path.join(repo, 'config.example.json'), 'utf8'));
  const serverCfg = {
    ...example,
    dns: { host: '127.0.0.1', host6: false, port: DNS_PORT, tcp: true, ednsUdpSize: 1232 },
    web: { host: '127.0.0.1', port: WEB_PORT, apiToken: TOKEN },
    workers: 1, dot: false, doh: false, internalFallback: false,
    blocklists: [], blockPagePort: 18053,
    categories: {
      steam: { enabled: true, target: '10.0.0.50', target6: '', domains: ['steamcontent.com', 'lancache.steamcontent.com'] },
      epic: { enabled: false, target: '10.0.0.50', target6: '', domains: ['epicgames.com'] }
    }
  };
  fs.writeFileSync(cfgPath, JSON.stringify(serverCfg, null, 2));

  const child = spawn(process.execPath, [path.join(repo, 'server.js')], {
    env: { ...process.env, STELLARDNS_CONFIG: cfgPath, STELLARDNS_DATA: path.join(tmp, 'data') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  child.stdout.on('data', d => { serverLog += d.toString(); });
  child.stderr.on('data', d => { serverLog += d.toString(); });

  const base = `http://127.0.0.1:${WEB_PORT}`;
  const up = await waitFor(() => discover.probe('127.0.0.1', WEB_PORT, 500).then(Boolean), 25000);
  is(up, 'server answers /api/client/ping');
  if (!up) {
    console.error(serverLog.slice(-800));
    child.kill();
    process.exit(1);
  }

  // --- discovery ------------------------------------------------------------
  const hit = await discover.probe('127.0.0.1', WEB_PORT, 800);
  is(hit && hit.version === '26.0.0', 'discovery reports the server version');

  // --- a pre-v25 server -----------------------------------------------------
  // Measured on a real 24.1.0 box: /api/client/ping is not a route, so its auth gate answers 401;
  // with a valid token /api/client/rules falls through to 404. That made discovery claim nothing
  // was on the network and Preview print a bare "HTTP 404". Both must name the real problem.
  const legacy = require('http').createServer((req, res) => {
    if (req.url === '/api/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ name: 'stellardns', version: '24.1.0', codename: 'Spaceland' }));
    }
    if (req.url === '/api/client/ping') {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end('{"error":"bad or missing token"}');
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise(r => legacy.listen(0, '127.0.0.1', r));
  const legacyPort = legacy.address().port;
  const legacyHit = await discover.probe('127.0.0.1', legacyPort, 800);
  is(legacyHit && legacyHit.version === '24.1.0' && legacyHit.rulesAvailable === false,
    'a pre-v25 server is found and flagged as too old for rules');
  let oldMsg = '';
  try { await rules.fetchRules(`http://127.0.0.1:${legacyPort}`, TOKEN); } catch (e) { oldMsg = e.message; }
  is(/24\.1\.0/.test(oldMsg) && /v25/.test(oldMsg),
    `a pre-v25 server is named instead of answering HTTP 404 (${oldMsg})`);
  let oldTokenMsg = '';
  try { await rules.fetchRules(`http://127.0.0.1:${legacyPort}`, 'wrong-token'); } catch (e) { oldTokenMsg = e.message; }
  is(/24\.1\.0/.test(oldTokenMsg) && !/rejected the token/.test(oldTokenMsg),
    'a pre-v25 server is not blamed on the token');
  await new Promise(r => legacy.close(r));

  // --- fetch + auth ---------------------------------------------------------
  let rejected = false;
  try { await rules.fetchRules(base, 'wrong-token'); } catch (e) { rejected = /token/.test(e.message); }
  is(rejected, 'wrong token is rejected with a useful message');

  const bundle = await rules.fetchRules(base, TOKEN);
  is(bundle.service === 'stellardns' && bundle.categories.steam.target === '10.0.0.50', 'ruleset carries category targets');
  is(bundle.categories.steam.domains.includes('lancache.steamcontent.com'), 'ruleset carries category domains');
  // The server merges its built-in launcher categories with the configured ones, so the
  // invariant is that the reported counts match the payload — not a fixed number.
  const sumDomains = Object.values(bundle.categories).reduce((n, c) => n + c.domains.length, 0);
  is(bundle.counts.categories === Object.keys(bundle.categories).length && bundle.counts.domains === sumDomains,
    `ruleset counts match its payload (${bundle.counts.categories} categories, ${bundle.counts.domains} domains)`);
  is(bundle.categories.steam.domains.length === 2 && bundle.categories.epic.domains.length === 1,
    'configured categories replace the built-in ones of the same name');

  // --- selection ------------------------------------------------------------
  const picked = rules.selectRules(bundle, { categories: ['steam'], blocklists: [], allowlist: true });
  is(Object.keys(picked.categories).length === 1 && !picked.categories.epic, 'selection keeps only the chosen category');

  // --- rewrites actually answer --------------------------------------------
  const cfg = load();
  cfg.listen = { host: '127.0.0.1', port: CLIENT_DNS };
  cfg.gui = { host: '127.0.0.1', port: CLIENT_GUI };
  cfg.upstreams = [{ name: 'fake', protocol: 'https', hostname: 'example.invalid', path: '/dns-query' }];
  rules.applyRules(cfg, picked, bundle);
  is(cfg.importedFrom && cfg.importedFrom.server === base, 'import records where the rules came from');

  const list = new Blocklist();
  const resolver = new Resolver(cfg, list);
  resolver.forward = async msg => {
    const q = dnsPacket.decode(msg);
    return dnsPacket.encode({
      type: 'response', id: q.id,
      flags: dnsPacket.RECURSION_DESIRED | dnsPacket.RECURSION_AVAILABLE,
      questions: q.questions,
      answers: [{ name: q.questions[0].name, type: 'A', ttl: 60, class: 'IN', data: '203.0.113.9' }]
    });
  };
  const listeners = await startListeners(resolver, cfg);

  // The safe default: rules are saved, traffic is untouched.
  is(cfg.rewritesEnabled === false, 'an import leaves rewrites disabled by default');
  const inert = await askUdp(CLIENT_DNS, 'lancache.steamcontent.com');
  is(inert.answers[0] && inert.answers[0].data === '203.0.113.9', 'saved rewrites do not move traffic until enabled');

  cfg.rewritesEnabled = true;
  resolver.reload(cfg);
  const rewritten = await askUdp(CLIENT_DNS, 'lancache.steamcontent.com');
  is(rewritten.answers[0] && rewritten.answers[0].data === '10.0.0.50', 'enabling rewrites answers with the imported cache IP');
  const sub = await askUdp(CLIENT_DNS, 'cdn.steamcontent.com');
  is(sub.answers[0] && sub.answers[0].data === '10.0.0.50', 'imported category covers subdomains');
  const notImported = await askUdp(CLIENT_DNS, 'epicgames.com');
  is(notImported.answers[0] && notImported.answers[0].data === '203.0.113.9', 'a category that was not imported is not rewritten');

  // --- GUI endpoints --------------------------------------------------------
  const server = await gui.start(resolver, cfg, { save: () => {}, reload: async () => { resolver.reload(cfg); } });
  const settings = await httpJson(CLIENT_GUI, 'GET', '/api/settings');
  is(settings.status === 200 && settings.json.categories.includes('steam'), 'GUI settings list the imported category');

  const preview = await httpJson(CLIENT_GUI, 'POST', '/api/rules/preview', { url: base, token: TOKEN });
  is(preview.status === 200 && preview.json.categories.steam, 'GUI preview reaches the server with the token');

  const badPreview = await httpJson(CLIENT_GUI, 'POST', '/api/rules/preview', { url: base, token: 'nope' });
  is(badPreview.status === 400 && /token/.test(badPreview.json.error), 'GUI preview surfaces a bad token');

  cfg.rewritesEnabled = false;
  const imported = await httpJson(CLIENT_GUI, 'POST', '/api/rules/import', {
    url: base, token: TOKEN,
    selection: { categories: ['steam', 'epic'], blocklists: [], allowlist: true, applyRewrites: true }
  });
  is(imported.status === 200 && imported.json.categories.length === 2, 'GUI import applies the selection');
  is(cfg.rewritesEnabled === true, 'GUI import enables rewrites only when asked');
  is(cfg.categories.epic && cfg.categories.epic.enabled === false, 'disabled categories are imported with their state');

  const rebound = await httpJson(CLIENT_GUI, 'GET', '/api/settings', null, 'evil.example.com');
  is(rebound.status === 403, 'rule endpoints stay loopback-only');

  const rewrittenAfter = await askUdp(CLIENT_DNS, 'epicgames.com');
  is(rewrittenAfter.answers[0] && rewrittenAfter.answers[0].data === '203.0.113.9',
    'a disabled category imported from the server does not start rewriting');

  listeners.close();
  server.close();
  child.kill();

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('  FAIL  ' + e.message); console.error(e.stack); process.exit(1); });
