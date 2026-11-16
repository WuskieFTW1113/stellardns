'use strict';
/* The GUI is a local HTTP server on loopback plus one HTML file.
 * That is what makes one UI work in three shells: WebView2 on Windows, WebKitGTK inside the
 * AppImage, and WKWebView on macOS all just load http://127.0.0.1:5381.
 *
 * Everything that talks to a StellarDNS server happens here, server-side, not in the page:
 * the token never reaches the browser, and there is no cross-origin request to explain.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const rules = require('./rules');
const discover = require('./discover');

const BLOCK_RESPONSES = ['nxdomain', 'zeroip'];
const UPSTREAM_PROTOCOLS = ['https', 'tls'];

function clamp(n, lo, hi, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

function start(resolver, cfg, hooks = {}) {
  // Tests inject a fake so the suite never touches this machine's real resolver.
  const dns = hooks.sysdns || require('./sysdns');
  // Taking over system DNS only makes sense if this process answers on 53; otherwise every
  // lookup on the machine would go to a port nothing is listening on.
  const portReady = () => Number(cfg.listen.port) === 53;

  // ...and only if the encrypted upstream actually answers. A client that takes over DNS and
  // then cannot reach its upstream leaves the machine worse than it found it, which is the
  // difference between a filtered resolver and no resolver at all.
  const upstream = { at: 0, ok: null, error: '' };
  async function probeUpstream() {
    try {
      const dnsPacket = require('dns-packet');
      const q = dnsPacket.encode({
        type: 'query', id: (Date.now() & 0xffff), flags: dnsPacket.RECURSION_DESIRED,
        questions: [{ type: 'A', name: 'example.com' }]
      });
      // forward(), not handle(): the probe must not touch the cache or the counters that the
      // UI and the suites read as real client traffic.
      const out = await resolver.forward(q);
      const rcode = out && out.length > 3 ? (out[3] & 0x0f) : 2;
      upstream.ok = rcode === 0;
      upstream.error = upstream.ok ? '' : (resolver.stats.lastError || `upstream answered rcode ${rcode}`);
    } catch (e) {
      upstream.ok = false;
      upstream.error = e.message;
    }
    upstream.at = Date.now();
  }
  probeUpstream();
  const probeTimer = setInterval(probeUpstream, 60000);
  if (probeTimer.unref) probeTimer.unref();

  const dnsReady = hooks.dnsReady || (() => portReady() && upstream.ok !== false);
  const dnsWhy = () => {
    if (!portReady()) {
      const owner = cfg.listen.blockedBy ? ` - it is held by ${cfg.listen.blockedBy}` : '';
      return `the client is listening on port ${cfg.listen.port}, not 53${owner}. ` +
        'Free port 53 and restart before pointing this machine at the client';
    }
    if (upstream.ok === false) {
      return `the encrypted upstream is not answering (${upstream.error}); ` +
        'taking over now would leave this machine without DNS';
    }
    return '';
  };
  const publicDir = path.join(__dirname, '..', 'public');
  const host = (cfg.gui && cfg.gui.host) || '127.0.0.1';
  const port = Number((cfg.gui && cfg.gui.port) || 5381);
  const save = () => { if (hooks.save) hooks.save(cfg); };
  const reload = async () => { if (hooks.reload) await hooks.reload(); };

  const settingsView = () => ({
    listen: cfg.listen,
    upstreams: cfg.upstreams || [],
    blocklists: cfg.blocklists || [],
    allowlist: cfg.allowlist || [],
    blockResponse: cfg.blockResponse || 'nxdomain',
    blockingEnabled: cfg.blockingEnabled !== false,
    cacheMaxEntries: cfg.cacheMaxEntries,
    ttlMin: cfg.ttlMin,
    ttlMax: cfg.ttlMax,
    setSystemDns: cfg.setSystemDns !== false,
    dnsPromptShown: cfg.dnsPromptShown === true,
    dnsManaged: cfg.setSystemDns === true && !!cfg.systemDnsBackup,
    categories: Object.keys(cfg.categories || {}),
    rewritesEnabled: cfg.rewritesEnabled === true,
    importedFrom: cfg.importedFrom || null,
    gui: cfg.gui
  });

  const state = () => ({
    version: require('../package.json').version,
    running: true,
    listening: cfg.listen,
    blocking: resolver.blocking,
    stats: resolver.stats,
    blocklist: resolver.blocklist ? { entries: resolver.blocklist.size, updatedAt: resolver.blocklist.meta.updatedAt, sources: resolver.blocklist.meta.sources } : null,
    upstreams: resolver.upstreams.map(u => ({ name: u.name, protocol: u.protocol || 'https', hostname: u.hostname })),
    cache: { entries: resolver.cache.size, max: cfg.cacheMaxEntries },
    rewrites: (cfg.categories ? Object.keys(cfg.categories).length : 0),
    rewritesEnabled: cfg.rewritesEnabled === true,
    importedFrom: cfg.importedFrom || null,
    systemDns: cfg.setSystemDns !== false,
    dns: {
      // Asked once: the flag is written when the user answers, either way.
      prompt: cfg.dnsPromptShown !== true && !cfg.systemDnsBackup,
      managed: cfg.setSystemDns === true && !!cfg.systemDnsBackup,
      canApply: dnsReady(),
      why: dnsWhy(),
      listeningOn: cfg.listen.port,
      blockedPort: cfg.listen.blockedPort || null,
      blockedBy: cfg.listen.blockedBy || null,
      platform: process.platform
    }
  });

  async function applySettings(partial) {
    const restart = [];
    if (partial.listen) {
      const p = clamp(partial.listen.port, 1, 65535, cfg.listen.port);
      const h = String(partial.listen.host || cfg.listen.host || '127.0.0.1');
      if (p !== cfg.listen.port || h !== cfg.listen.host) restart.push('listen address');
      cfg.listen = { host: h, port: p };
    }
    if (Array.isArray(partial.upstreams)) {
      const list = partial.upstreams.filter(u => u && u.hostname).map(u => {
        const protocol = UPSTREAM_PROTOCOLS.includes(u.protocol) ? u.protocol : 'https';
        const out = { name: String(u.name || u.hostname).slice(0, 40), protocol, hostname: String(u.hostname) };
        if (protocol === 'https') { out.path = String(u.path || '/dns-query'); out.port = clamp(u.port, 1, 65535, 443); }
        else out.port = clamp(u.port, 1, 65535, 853);
        return out;
      });
      if (!list.length) throw new Error('at least one upstream is required');
      cfg.upstreams = list;
      restart.push('upstreams');
    }
    if (Array.isArray(partial.blocklists)) {
      cfg.blocklists = partial.blocklists.filter(l => l && l.url).map(l => {
        if (!/^https:\/\//i.test(String(l.url))) throw new Error('blocklists must be https URLs');
        return { name: String(l.name || l.url).slice(0, 60), url: String(l.url), enabled: l.enabled !== false };
      });
    }
    if (Array.isArray(partial.allowlist)) {
      cfg.allowlist = partial.allowlist.map(d => String(d).toLowerCase().trim()).filter(Boolean);
    }
    if (partial.blockResponse) {
      if (!BLOCK_RESPONSES.includes(partial.blockResponse)) throw new Error('blockResponse must be nxdomain or zeroip');
      cfg.blockResponse = partial.blockResponse;
    }
    if (typeof partial.blockingEnabled === 'boolean') cfg.blockingEnabled = partial.blockingEnabled;
    if (partial.cacheMaxEntries !== undefined) cfg.cacheMaxEntries = clamp(partial.cacheMaxEntries, 100, 500000, cfg.cacheMaxEntries);
    if (partial.ttlMin !== undefined) cfg.ttlMin = clamp(partial.ttlMin, 1, 86400, cfg.ttlMin);
    if (partial.ttlMax !== undefined) cfg.ttlMax = clamp(partial.ttlMax, 1, 86400, cfg.ttlMax);
    // The toggle is honest: turning it on applies now, turning it off restores the saved
    // resolvers. A flag that only claims to manage DNS is worse than no flag.
    if (typeof partial.setSystemDns === 'boolean' && partial.setSystemDns !== (cfg.setSystemDns === true)) {
      if (partial.setSystemDns) {
        if (!dnsReady()) throw new Error(dnsWhy() + ', so system DNS was left alone');
        const backup = dns.apply(cfg);
        // Keep the first restore point: applying twice must not replace the original
        // resolvers with 127.0.0.1.
        cfg.systemDnsBackup = cfg.systemDnsBackup || backup;
        cfg.setSystemDns = true;
        cfg.dnsPromptShown = true;
      } else {
        if (cfg.systemDnsBackup) {
          const r = dns.restore(cfg.systemDnsBackup);
          if (!r.restored) throw new Error('could not restore DNS: ' + (r.reason || 'unknown'));
          cfg.systemDnsBackup = null;
        }
        cfg.setSystemDns = false;
      }
    }
    if (typeof partial.rewritesEnabled === 'boolean') cfg.rewritesEnabled = partial.rewritesEnabled;
    save();
    await reload();
    return { ok: true, restartRequired: restart.length > 0, changed: restart };
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    // Loopback only: a Host header from a rebinding page must not reach this API.
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(req.headers.host || '')) {
      return send(403, { error: 'loopback only' });
    }
    /* The Host check stops DNS rebinding but not a page that simply POSTs to 127.0.0.1: the
     * browser supplies that Host itself, and a no-cors request may use a simple content type.
     * Without this, any site the user visits could toggle blocking or repoint the upstreams.
     * Writes must therefore be same-origin (or from a local script that sends no Origin) and
     * JSON — which a cross-site form or no-cors fetch cannot send without a preflight that
     * this server never answers. */
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      const site = req.headers['sec-fetch-site'];
      if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) {
        return send(403, { error: 'cross-origin writes are refused' });
      }
      if (site && site !== 'same-origin' && site !== 'none') {
        return send(403, { error: 'cross-origin writes are refused' });
      }
      if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
        return send(415, { error: 'content-type must be application/json' });
      }
    }
    const readJson = async () => {
      let body = '';
      for await (const c of req) body += c;
      try { return JSON.parse(body || '{}'); } catch { return {}; }
    };

    if (u.pathname === '/' || u.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(path.join(publicDir, 'index.html')));
    }
    if (u.pathname === '/api/state') return send(200, state());
    if (u.pathname === '/api/settings' && req.method === 'GET') return send(200, settingsView());
    if (u.pathname === '/api/settings' && req.method === 'POST') {
      try { return send(200, await applySettings(await readJson())); }
      catch (e) { return send(400, { error: e.message }); }
    }

    if (u.pathname === '/api/rules/discover' && req.method === 'POST') {
      const b = await readJson();
      try {
        if (b.url) {
          const raw = String(b.url).trim().replace(/^https?:\/\//i, '');
          const [h, p] = raw.split(':');
          const hit = await discover.probe(h, Number(p) || discover.DEFAULT_PORT);
          return send(200, { servers: hit ? [hit] : [] });
        }
        const found = await discover.scan({ port: Number(b.port) || discover.DEFAULT_PORT });
        return send(200, { servers: found });
      } catch (e) { return send(500, { error: e.message }); }
    }
    if (u.pathname === '/api/rules/preview' && req.method === 'POST') {
      const b = await readJson();
      try { return send(200, await rules.fetchRules(b.url, b.token)); }
      catch (e) { return send(400, { error: e.message }); }
    }
    if (u.pathname === '/api/rules/import' && req.method === 'POST') {
      const b = await readJson();
      try {
        const bundle = await rules.fetchRules(b.url, b.token);
        const picked = rules.selectRules(bundle, b.selection || {});
        rules.applyRules(cfg, picked, bundle);
        // Storing rules and applying them are separate decisions: the import only turns
        // rewrites on when the request says so, and off is the default.
        if (b.selection && typeof b.selection.applyRewrites === 'boolean') {
          cfg.rewritesEnabled = b.selection.applyRewrites;
        }
        save();
        await reload();
        return send(200, {
          ok: true, imported: cfg.importedFrom,
          categories: Object.keys(picked.categories), blocklists: picked.blocklists.length,
          allowlist: picked.allowlist.length
        });
      } catch (e) { return send(400, { error: e.message }); }
    }

    if (u.pathname === '/api/allowlist' && req.method === 'GET') return send(200, cfg.allowlist || []);
    if (u.pathname === '/api/allowlist' && req.method === 'POST') {
      const b = await readJson();
      try { return send(200, await applySettings({ allowlist: b.allowlist || [] })); }
      catch (e) { return send(400, { error: e.message }); }
    }

    if (u.pathname === '/api/dns/apply' && req.method === 'POST') {
      if (!dnsReady()) {
        return send(400, { error: dnsWhy() || 'system DNS was left alone' });
      }
      try {
        const backup = dns.apply(cfg);
        cfg.systemDnsBackup = cfg.systemDnsBackup || backup;
        cfg.setSystemDns = true;
        cfg.dnsPromptShown = true;
        save();
        return send(200, {
          ok: true, platform: backup.platform,
          iface: backup.iface || backup.service || null,
          before: backup.before || null,
          elevated: backup.elevated === true
        });
      } catch (e) { return send(500, { error: 'DNS change failed: ' + e.message }); }
    }
    if (u.pathname === '/api/dns/dismiss' && req.method === 'POST') {
      cfg.dnsPromptShown = true;
      save();
      return send(200, { ok: true });
    }
    if (u.pathname === '/api/dns/restore' && req.method === 'POST') {
      try {
        const r = dns.restore(cfg.systemDnsBackup);
        if (!r.restored) return send(400, { error: r.reason || 'could not restore' });
        cfg.systemDnsBackup = null;
        cfg.setSystemDns = false;
        save();
        return send(200, { ok: true });
      } catch (e) { return send(500, { error: e.message }); }
    }

    if (u.pathname === '/api/toggle' && req.method === 'POST') {
      const b = await readJson();
      resolver.blocking = !!b.blocking;
      cfg.blockingEnabled = resolver.blocking;
      save();
      return send(200, { blocking: resolver.blocking });
    }
    if (u.pathname === '/api/flush' && req.method === 'POST') {
      return send(200, { flushed: resolver.flush() });
    }
    if (u.pathname === '/api/test') {
      const name = u.searchParams.get('name') || '';
      const type = (u.searchParams.get('type') || 'A').toUpperCase();
      if (!name) return send(400, { error: 'name required' });
      try {
        const dnsPacket = require('dns-packet');
        const q = dnsPacket.encode({ type: 'query', id: Math.floor(Math.random() * 65535), flags: dnsPacket.RECURSION_DESIRED, questions: [{ type, name }] });
        const t0 = Date.now();
        const out = await resolver.handle(q);
        const r = out ? dnsPacket.decode(out) : null;
        return send(200, {
          ms: Date.now() - t0, rcode: r ? r.rcode : 'no answer',
          answers: r ? (r.answers || []).map(a => ({ type: a.type, data: a.data, ttl: a.ttl })) : []
        });
      } catch (e) { return send(500, { error: e.message }); }
    }
    send(404, { error: 'not found' });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => resolve({ server, url: `http://${host}:${port}`, close: () => server.close() }));
  });
}

module.exports = { start };
