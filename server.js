#!/usr/bin/env node
/* StellarDNS — gaming-oriented DNS server
 * LANCache-style static rewrites (no lancache-dns), launcher toggles,
 * AdGuard blocklists, never-cache-failures, circuit breakers, serve-stale,
 * query coalescing, EDNS 1232, snapshot persistence, query log, web UI.
 */
'use strict';

const dgram = require('dgram');
const net = require('net');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dnsPacket = require('dns-packet');
const cluster = require('cluster');
const os = require('os');

// ---------------------------------------------------------------- config
const DATA_DIR = process.env.STELLARDNS_DATA || path.join(__dirname, 'data');
const CONFIG_PATH = process.env.STELLARDNS_CONFIG || path.join(__dirname, 'config.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

const DEFAULT_CONFIG = {
  dns: { host: '0.0.0.0', host6: '::', port: 53, tcp: true, ednsUdpSize: 1232 },  // host6:'' or null disables IPv6
  web: { host: '0.0.0.0', port: 5380, apiToken: '' }, // empty token = generated on first run
  upstreams: [
    { name: 'cloudflare', address: '1.1.1.1', port: 53 },
    { name: 'quad9', address: '9.9.9.9', port: 53 }
  ],
  race: false,                    // race two healthiest upstreams
  ecs: false,                     // EDNS Client Subnet: off by default (privacy). true = forward /24 (v4) //56 (v6)
  ecsPrefixV4: 24, ecsPrefixV6: 56,
  qnameMinimization: true,        // RFC 9156: minimize labels sent when doing our own iterative resolution
  happyEyeballs: false,           // race A+AAAA and prefer whichever upstream answers first
  // filterAAAA: suppress AAAA answers for PUBLIC names so clients use IPv4.
  // Useful when your IPv6 path is a slow 6in4 tunnel (HE etc.) and clients would
  // otherwise prefer it. Local records, internal zones and rewrite target6 are NOT
  // affected. false | true | array of client CIDRs to apply it to.
  filterAAAA: false,
  workers: 0,                     // 0 = auto (one per CPU core, max 8); 1 = single process
  dnssec: 'passthrough',          // 'passthrough' = pass upstream AD bit | 'strict' = SERVFAIL if a
                                  //   response that arrived over our secure transport lost its AD bit
                                  //   unexpectedly | 'off' = don't request DO
  dnssecStrictDomains: [],        // suffixes that MUST validate (AD=1) in strict mode, e.g. ['cloudflare.com']
  rebindingProtection: true,      // block external names resolving to private IPs (rewrites/local exempt)
  rebindingAllow: [],             // extra domain suffixes allowed to resolve to private IPs
  cache: {
    maxEntries: 150000,           // PER WORKER. With workers:0 (one per core) the real
                                  // total is maxEntries x cores — keep this modest.
    maxHeapMB: 512,               // hard RAM guard per worker: evict aggressively above this
    minTtl: 5,
    maxTtl: 86400,
    negMaxTtl: 900,               // cap for NXDOMAIN/NODATA (RFC 2308 negatives ONLY)
    serveStale: true,
    serveStaleMaxAge: 86400 * 3,  // how stale is acceptable during outage
    prefetch: true,
    prefetchWindow: 10,           // re-resolve when entry is this close to expiry & hot
    snapshotIntervalSec: 300
  },
  circuit: { windowSize: 20, failThreshold: 0.5, probeIntervalMs: 3000 },
  timeoutMs: { min: 250, max: 3000, initial: 800 }, // adaptive SRTT bounds
  log: { ringSize: 2000, file: true, maxFileBytes: 50 * 1024 * 1024, keepFiles: 3 },
  blocklists: [
    // AdGuard/hosts format URLs. Example:
    // { name: 'hagezi-pro', url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/pro.txt', enabled: true }
  ],
  blocklistRefreshHours: 24,
  blockedResponse: 'nxdomain',    // 'nxdomain' | 'zeroip'
  dohCanaryNxdomain: true,        // serve use-application-dns.net as NXDOMAIN (disables Firefox DoH)
  clientAcl: [],                  // e.g. ['192.168.0.0/16','10.0.0.0/8'] — empty = allow all
  rateLimitPerClientQps: 0,       // 0 = disabled
  categories: {
    // LANCache-style consistent rewrites: every domain in `domains` answers with `target` (A) / `target6` (AAAA).
    // Suffix match: 'steamcontent.com' matches lancache.steamcontent.com etc. Toggle with `enabled`.
    steam:    { enabled: true, target: '', target6: '', domains: ['lancache.steamcontent.com', 'steamcontent.com', 'content.steampowered.com'] },
    epicgames: { enabled: true, target: '', target6: '', domains: ['epicgames-download1.akamaized.net', 'download.epicgames.com', 'download2.epicgames.com', 'download3.epicgames.com', 'download4.epicgames.com', 'fastly-download.epicgames.com'] },
    blizzard: { enabled: true, target: '', target6: '', domains: ['level3.blizzard.com', 'edgecast.blizzard.com', 'blizzard.gcdn.cloudn.co.kr', 'cdn.blizzard.com', 'us.cdn.blizzard.com', 'eu.cdn.blizzard.com'] },
    riot:     { enabled: true, target: '', target6: '', domains: ['l3cdn.riotgames.com', 'worldwide.l3cdn.riotgames.com', 'riotgamespatcher-a.akamaihd.net'] },
    wsus:     { enabled: true, target: '', target6: '', domains: ['windowsupdate.com', 'dl.delivery.mp.microsoft.com', 'tlu.dl.delivery.mp.microsoft.com'] },
    nintendo: { enabled: true, target: '', target6: '', domains: ['ccs.cdn.wup.shop.nintendo.net', 'cdn.nintendo.net'] },
    sony:     { enabled: true, target: '', target6: '', domains: ['gs2.ww.prod.dl.playstation.net', 'gs2.sonycoment.loris-e.llnwd.net'] },
    xboxlive: { enabled: true, target: '', target6: '', domains: ['assets1.xboxlive.com', 'assets2.xboxlive.com', 'xvcf1.xboxlive.com', 'xvcf2.xboxlive.com'] }
  },
  internalZones: [],           // e.g. ['internal','lan','home.arpa'] — never leak to PUBLIC upstreams
  conditionalForwarders: [],   // [{ zone:'stellarad.internal', upstreams:[{name,address,port}] }]
  // Names inside an internalZone that match no conditional forwarder and no local record are sent
  // here instead of NXDOMAIN — normally your router/firewall (OPNsense Unbound, pfSense, etc.),
  // which is authoritative for things like speedtest.internal.
  //   'auto'  = detect the default gateway at boot and use it (recommended for OPNsense/pfSense)
  //   [{address:'192.168.9.1',port:53}] = explicit
  //   false   = old behavior: NXDOMAIN (never asks anyone)
  internalFallback: 'auto',
  internalTimeoutMs: 700,      // max timeout for LAN-local forwarders (router/DC) — fail fast
  selfRecord: true,            // auto-register <hostname>.<internalZone> -> this host's IPs
  forwardLoopGuard: true,      // never forward internal/PTR queries back to a machine that forwards to us
  loopPeers: [],               // extra addresses of peer resolvers (e.g. the router's IPv6)
  reverseForwarders: [],       // optional: [{address:'192.168.6.110'}] for private PTR lookups;
                               // defaults to your AD DC forwarders / internal fallback
  rebindingProtection: true,
  rebindingAllowlist: [],
  dnsCookies: true,
  failoverJitter: true,
  // Local authoritative records. Types: A, AAAA, TXT, SRV, CNAME. Used for apt-cacher-ng SRV,
  // Apple content-caching TXT, internal names, etc.
  localRecords: [
    // { name: '_apt_proxy._tcp.lan', type: 'SRV', data: { priority: 0, weight: 0, port: 3142, target: 'aptcache.lan' }, ttl: 3600 },
    // { name: 'aptcache.lan', type: 'A', data: '10.0.0.5', ttl: 3600 },
    // { name: '_aaplcache._tcp.lan', type: 'TXT', data: 'prs=203.0.113.10-203.0.113.20', ttl: 10800 },
  ]
};

function loadConfig() {
  let cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      cfg = deepMerge(cfg, user);
    } catch (e) {
      console.error('[config] parse error:', e.message);
      // Corrupt config: recover the last-known-good backup rather than silently
      // reverting to defaults (which would drop zones, forwarders and rewrites).
      try {
        const bak = CONFIG_PATH + '.bak';
        if (fs.existsSync(bak)) {
          const prev = JSON.parse(fs.readFileSync(bak, 'utf8'));
          cfg = deepMerge(cfg, prev);
          console.warn('[config] RECOVERED settings from config.json.bak');
          try { fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + '.corrupt'); } catch {}
        } else console.error('[config] no backup available — using defaults');
      } catch (e2) { console.error('[config] backup unreadable, using defaults:', e2.message); }
    }
  }
  // --- migration: v5-v8 shipped dns.host6:"" which silently disabled the IPv6 listener.
  // Treat empty string as "unset" and enable dual-stack. Use false/null to disable on purpose.
  if (cfg.dns && cfg.dns.host6 === '') {
    cfg.dns.host6 = '::';
    console.log('[migrate] dns.host6 was "" (IPv6 listener disabled) -> set to "::"');
  }
  if (!cfg.web.apiToken) {
    cfg.web.apiToken = crypto.randomBytes(24).toString('hex');
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  return cfg;
}
function deepMerge(base, over) {
  if (Array.isArray(over)) return over;
  if (over && typeof over === 'object') {
    const out = { ...base };
    for (const k of Object.keys(over)) out[k] = deepMerge(base ? base[k] : undefined, over[k]);
    return out;
  }
  return over === undefined ? base : over;
}
let config = loadConfig();

// ---------------------------------------------------------------- auth: users (scrypt) + sessions
const AUTH_FILE = path.join(DATA_DIR, 'users.json');
function loadUsers() {
  try { if (fs.existsSync(AUTH_FILE)) return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); } catch {}
  return {};
}
function saveUsers(u) { fs.writeFileSync(AUTH_FILE, JSON.stringify(u, null, 2)); }
let users = loadUsers();
function hashPw(pw, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPw(pw, rec) {
  if (!rec) return false;
  const h = crypto.scryptSync(pw, rec.salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(rec.hash));
}
// seed a default admin on first run if no users exist; password printed once
function ensureAdmin() {
  if (Object.keys(users).length) return;
  const pw = crypto.randomBytes(9).toString('base64').replace(/[/+=]/g, '').slice(0, 12);
  users.admin = { ...hashPw(pw), role: 'admin' };
  saveUsers(users);
  console.log(`[auth] created default user 'admin' / '${pw}'  (change it in the UI)`);
}
const sessions = new Map(); // sid -> { user, exp }
const SESSION_MS = 12 * 3600 * 1000;
function newSession(user) {
  const sid = crypto.randomBytes(24).toString('hex');
  sessions.set(sid, { user, exp: Date.now() + SESSION_MS });
  return sid;
}
function sessionUser(req) {
  const cookie = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('sdsid='));
  if (!cookie) return null;
  const sid = cookie.slice(6);
  const s = sessions.get(sid);
  if (!s || s.exp < Date.now()) { sessions.delete(sid); return null; }
  return s.user;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of sessions) if (v.exp < now) sessions.delete(k); }, 60000);

// ---------------------------------------------------------------- memory budget sanity
// maxEntries and maxHeapMB are PER WORKER. With workers:0 (one per core) the totals
// multiply, which is how an 8-core LXC ended up out of memory.
function applyMemoryBudget() {
  try {
    const os = require('os');
    let totalMB = Math.round(os.totalmem() / 1048576);
    // In an LXC, os.totalmem() reports the HOST's RAM. Prefer the cgroup limit if present.
    for (const p of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
      try {
        const v = fs.readFileSync(p, 'utf8').trim();
        if (v && v !== 'max') { const mb = Math.round(Number(v) / 1048576); if (mb > 0 && mb < totalMB) totalMB = mb; }
      } catch {}
    }
    const workers = WORKER_COUNT || 1;
    // Give all workers combined at most ~40% of container RAM for cache.
    // 25% of container RAM across all workers, and never more than 256MB each — a home
    // resolver's working set is tens of MB; the rest is just OOM risk.
    const perWorker = Math.min(256, Math.max(64, Math.floor((totalMB * 0.25) / workers)));
    if (!config.cache.maxHeapMB || config.cache.maxHeapMB > perWorker) {
      if (IS_PRIMARY) console.log(`[memory] container ${totalMB}MB, ${workers} worker(s) -> cache budget ${perWorker}MB each`);
      config.cache.maxHeapMB = perWorker;
    }
  } catch (e) { /* keep configured value */ }
}

// ---------------------------------------------------------------- crash resilience
// A resolver is infrastructure: one malformed packet or one unexpected edge case must not
// take DNS down for the whole network. Log loudly, keep serving.
let _lastFatal = 0, _fatalCount = 0;
process.on('uncaughtException', err => {
  _fatalCount++;
  const now = Date.now();
  console.error(`[fatal] uncaught: ${err && err.stack ? err.stack : err}`);
  // If we are genuinely wedged (many faults in a short window) exit so the service
  // manager restarts us cleanly rather than serving broken answers forever.
  if (now - _lastFatal < 1000) { if (_fatalCount > 50) { console.error('[fatal] fault storm — exiting for restart'); process.exit(1); } }
  else { _fatalCount = 1; }
  _lastFatal = now;
});
process.on('unhandledRejection', reason => {
  console.error('[fatal] unhandled rejection:', reason && reason.stack ? reason.stack : reason);
});

// ---------------------------------------------------------------- stats
const startTime = Date.now();
const stats = {
  queries: 0, cacheHits: 0, cacheStale: 0, cacheMiss: 0,
  rewrites: 0, blocked: 0, local: 0, upstreamFail: 0, servfail: 0,
  coalesced: 0, prefetches: 0, tcpQueries: 0, rateLimited: 0, aclDenied: 0,
  perCategory: {}
};

// ---------------------------------------------------------------- query log ring
const queryLog = [];
let _ringHead = 0;
function logQuery(entry) {
  // Fixed-size circular buffer. Array.shift() is O(n): once the log filled to ringSize
  // every query memmoved the whole array.
  const cap = config.log.ringSize || 2000;
  if (queryLog.length < cap) queryLog.push(entry);
  else { queryLog[_ringHead] = entry; _ringHead = (_ringHead + 1) % cap; }
  if (config.log.file) fileLog(entry);
}
function queryLogInOrder() {
  const cap = config.log.ringSize || 2000;
  if (queryLog.length < cap) return queryLog;
  return queryLog.slice(_ringHead).concat(queryLog.slice(0, _ringHead));
}
let logStream = null, logBytes = 0;
let _logBuf = [], _logFlushTimer = null;
function flushFileLog() {
  _logFlushTimer = null;
  if (!_logBuf.length) return;
  const logPath = path.join(DATA_DIR, 'queries.log');
  if (!logStream) {
    try { logBytes = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0; } catch { logBytes = 0; }
    logStream = fs.createWriteStream(logPath, { flags: 'a' });
  }
  const chunk = _logBuf.join('');
  _logBuf = [];
  logBytes += Buffer.byteLength(chunk);
  logStream.write(chunk);
  if (logBytes >= config.log.maxFileBytes) rotateLogs(logPath);
}
function fileLog(entry) {
  // Batch: one write per 500ms (or 500 lines) instead of a stringify + stream write
  // on every single query.
  _logBuf.push(JSON.stringify(entry) + '\n');
  if (_logBuf.length >= 500) return flushFileLog();
  if (!_logFlushTimer) _logFlushTimer = setTimeout(flushFileLog, 500);
}
function rotateLogs(logPath) {
  logStream.end(); logStream = null; logBytes = 0;
  for (let i = config.log.keepFiles - 1; i >= 1; i--) {
    const from = `${logPath}.${i}`, to = `${logPath}.${i + 1}`;
    if (fs.existsSync(from)) fs.renameSync(from, to);
  }
  if (fs.existsSync(logPath)) fs.renameSync(logPath, `${logPath}.1`);
}

// ---------------------------------------------------------------- policy engine
// blockSet: exact domains; blockSuffixes checked by walking labels.
let blockSet = new Set();
let blockMeta = { entries: 0, lists: {}, updatedAt: null };
const BLOCKLIST_GOOD = path.join(DATA_DIR, 'blocklist.good.json');

function parseBlocklistText(text) {
  // Supports AdGuard (||domain^), hosts (0.0.0.0 domain / 127.0.0.1 domain), and plain-domain formats.
  const out = new Set();
  for (let raw of text.split('\n')) {
    let line = raw.trim();
    if (!line || line.startsWith('!') || line.startsWith('#') || line.startsWith('[')) continue;
    if (line.includes('$')) continue;              // AdGuard rules with modifiers — skip (element hiding etc.)
    if (line.startsWith('@@')) continue;           // exceptions unsupported in v1
    let m;
    if ((m = line.match(/^\|\|([a-z0-9.*-]+)\^?$/i))) line = m[1];
    else if ((m = line.match(/^(?:0\.0\.0\.0|127\.0\.0\.1|::1?)\s+(\S+)/))) line = m[1];
    line = line.replace(/^\*\./, '').replace(/\.$/, '').toLowerCase();
    if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(line)) continue;
    out.add(line);
  }
  return out;
}

async function refreshBlocklists(force = false) {
  const lists = (config.blocklists || []).filter(b => b.enabled !== false);
  if (!lists.length) { blockSet = new Set(); blockMeta = { entries: 0, lists: {}, updatedAt: new Date().toISOString() }; return { ok: true, entries: 0 }; }
  const next = new Set(); const meta = {};
  let anyFail = false;
  for (const bl of lists) {
    try {
      const text = await fetchUrl(bl.url, 20000);
      const parsed = parseBlocklistText(text);
      if (parsed.size === 0) throw new Error('parsed 0 entries — refusing suspicious empty list');
      meta[bl.name || bl.url] = parsed.size;
      for (const d of parsed) next.add(d);
    } catch (e) {
      anyFail = true;
      console.error(`[blocklist] ${bl.name || bl.url}: ${e.message}`);
      meta[bl.name || bl.url] = `ERROR: ${e.message}`;
    }
  }
  // Validation-before-apply: if every list failed and we have a previous good set, keep it (rollback semantics).
  if (next.size === 0 && anyFail && blockSet.size > 0 && !force) {
    console.error('[blocklist] all lists failed — keeping previous good set');
    return { ok: false, kept: blockSet.size };
  }
  blockSet = next;
  blockMeta = { entries: next.size, lists: meta, updatedAt: new Date().toISOString() };
  try { fs.writeFileSync(BLOCKLIST_GOOD, JSON.stringify({ meta: blockMeta, domains: [...next] })); } catch {}
  console.log(`[blocklist] active entries: ${next.size}`);
  return { ok: true, entries: next.size };
}
function loadBlocklistFromDisk() {
  try {
    if (fs.existsSync(BLOCKLIST_GOOD)) {
      const j = JSON.parse(fs.readFileSync(BLOCKLIST_GOOD, 'utf8'));
      blockSet = new Set(j.domains || []); blockMeta = j.meta || blockMeta;
      console.log(`[blocklist] restored ${blockSet.size} entries from last-good snapshot`);
    }
  } catch (e) { console.error('[blocklist] restore failed:', e.message); }
}

function fetchUrl(url, timeout = 15000, redirects = 5) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(fetchUrl(new URL(res.headers.location, url).href, timeout, redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// suffix walk: a.b.example.com -> a.b.example.com, b.example.com, example.com
// Walk label suffixes without allocating. The old generator did name.split('.') plus a
// slice().join() per label — roughly 7 allocations per call, on every query once
// blocklists were loaded. Callers pass a predicate and we hand back the first match.
function* suffixes(name) {          // kept for any non-hot-path callers
  const labels = name.split('.');
  for (let i = 0; i < labels.length - 1; i++) yield labels.slice(i).join('.');
}
function firstSuffixMatch(name, has) {
  if (has(name)) return name;
  for (let i = 0; i < name.length; i++) {
    if (name.charCodeAt(i) === 46 /* '.' */) {
      const s = name.slice(i + 1);
      if (s.indexOf('.') === -1) break;   // bare TLD: never match
      if (has(s)) return s;
    }
  }
  return null;
}
// Flat index: domain -> { cat, conf }. Rebuilt only when categories change.
// The previous version did Object.entries() + a linear Array.includes() scan across every
// category on EVERY query (and was called up to 3x per query). After importing the uklans
// list that was thousands of comparisons and a fresh array allocation per lookup — enough
// GC churn at real query rates to spike memory and kill the process.
let categoryIndex = null;
function buildCategoryIndex() {
  const idx = new Map();
  for (const [cat, c] of Object.entries(config.categories || {})) {
    for (const d of (c.domains || [])) {
      const k = String(d).toLowerCase().replace(/^\.|\.$/g, '');
      if (k && !idx.has(k)) idx.set(k, { cat, conf: c });
    }
  }
  categoryIndex = idx;
  return idx;
}
function invalidateCategoryIndex() { categoryIndex = null; }
function matchCategory(qname) {
  const idx = categoryIndex || buildCategoryIndex();
  if (!idx.size) return null;
  // Walk labels right-to-left without allocating: a.b.example.com -> b.example.com -> example.com
  const n = qname.length;
  let hit = idx.get(qname);
  if (hit) return hit;
  for (let i = 0; i < n; i++) {
    if (qname.charCodeAt(i) === 46 /* '.' */) {
      hit = idx.get(qname.slice(i + 1));
      if (hit) return hit;
    }
  }
  return null;
}
function isBlocked(qname) {
  return firstSuffixMatch(qname, s => blockSet.has(s));
}
// Local records compiled once into name -> { byType, all }. The previous version ran two
// Array.filter() calls (two allocations) plus a toLowerCase() per record on EVERY query,
// and rebindingExempt() did another lowercase + string concat per record per query. With
// records configured that is constant GC churn on the hot path.
let localIndex = null, localNameList = null, rebindAllowSet = null;
function buildLocalIndex() {
  const idx = new Map();
  const names = [];
  for (const r of (config.localRecords || [])) {
    if (!r || !r.name) continue;
    const n = String(r.name).toLowerCase().replace(/\.$/, '');
    const t = String(r.type || 'A').toUpperCase();
    let e = idx.get(n);
    if (!e) { e = { byType: new Map(), all: [] }; idx.set(n, e); names.push(n); }
    let arr = e.byType.get(t);
    if (!arr) { arr = []; e.byType.set(t, arr); }
    arr.push(r);
    e.all.push(r);
  }
  localIndex = idx; localNameList = names;
  return idx;
}
function invalidateLocalIndex() { localIndex = null; localNameList = null; rebindAllowSet = null; }
function matchLocal(qname, qtype) {
  const idx = localIndex || buildLocalIndex();
  const e = idx.get(qname);
  if (!e) return null;
  return { typed: e.byType.get(qtype) || [], any: e.all };
}

// ---------------------------------------------------------------- cache (never caches failures)
// key -> { answers, rcode, expiresAt, insertedAt, hits, wire? }
const cache = new Map();
function cacheKey(q) { return `${q.name.toLowerCase()}|${q.type}`; }

function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  const now = Date.now();
  if (now <= e.expiresAt) { e.hits++; return { entry: e, stale: false }; }
  if (config.cache.serveStale && now - e.expiresAt < config.cache.serveStaleMaxAge * 1000) {
    return { entry: e, stale: true };
  }
  cache.delete(key);
  return null;
}
function cacheSet(key, rcode, answers, ttl, ad) {
  // HARD RULE: only NOERROR-with-data, NODATA, and NXDOMAIN are cacheable.
  // SERVFAIL / REFUSED / timeouts are link-state, not facts — never stored.
  if (rcode !== 'NOERROR' && rcode !== 'NXDOMAIN') return;
  let t = Math.max(config.cache.minTtl, Math.min(ttl, config.cache.maxTtl));
  if (rcode === 'NXDOMAIN' || (rcode === 'NOERROR' && (!answers || !answers.length))) {
    t = Math.min(t, config.cache.negMaxTtl);
  }
  // RAM guard: entry count is a poor proxy for memory. If the worker's heap is over
  // budget, evict hard regardless of entry count. Without this, a large cache plus a
  // snapshot allocation can push an LXC into OOM.
  if ((++_heapSampleN & 0x3ff) === 0) {   // sample every 1024 inserts, cheap
    const heapMB = process.memoryUsage().heapUsed / 1048576;
    if (heapMB > (config.cache.maxHeapMB || 512)) {
      const drop = Math.ceil(cache.size / 4);   // shed 25%
      let i = 0;
      for (const k of cache.keys()) { cache.delete(k); if (++i >= drop) break; }
      stats.memEvictions = (stats.memEvictions || 0) + drop;
      console.warn(`[cache] heap ${Math.round(heapMB)}MB over budget — evicted ${drop} entries`);
    }
  }
  if (cache.size >= config.cache.maxEntries) {
    // cheap eviction: drop ~1% oldest-inserted
    const n = Math.ceil(config.cache.maxEntries / 100);
    const keys = [...cache.keys()].slice(0, n);
    for (const k of keys) cache.delete(k);
  }
  cache.set(key, { rcode, answers: answers || [], ad: !!ad, expiresAt: Date.now() + t * 1000, insertedAt: Date.now(), hits: 0 });
}

// snapshot persistence — instant warm restart
const SNAP = path.join(DATA_DIR, 'cache.snapshot.json');
const SNAP_MAX_ENTRIES = 50000;   // cap what we persist; warm-start does not need everything
function snapshotCache() {
  try {
    const now = Date.now();
    const tmp = SNAP + '.tmp';
    // Stream it out instead of building a full array copy AND a giant JSON string in memory.
    // The old version allocated both at once, which on a large cache was a multi-GB spike.
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, '[');
      let n = 0;
      for (const [k, e] of cache) {
        if (e.expiresAt <= now) continue;
        if (n >= SNAP_MAX_ENTRIES) break;
        const rec = JSON.stringify([k, e.rcode, e.answers, e.expiresAt, e.hits]);
        fs.writeSync(fd, (n ? ',' : '') + rec);
        n++;
      }
      fs.writeSync(fd, ']');
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, SNAP);
  } catch (e) {
    console.error('[snapshot] save failed:', e.message);
    try { fs.unlinkSync(SNAP + '.tmp'); } catch {}
  }
}
function restoreCache() {
  try {
    if (!fs.existsSync(SNAP)) return;
    const arr = JSON.parse(fs.readFileSync(SNAP, 'utf8'));
    const now = Date.now();
    let n = 0;
    for (const [k, rcode, answers, expiresAt, hits] of arr) {
      if (n >= SNAP_MAX_ENTRIES) break;
      if (expiresAt > now) { cache.set(k, { rcode, answers, expiresAt, insertedAt: now, hits: hits || 0 }); n++; }
    }
    console.log(`[snapshot] restored ${n} cache entries`);
  } catch (e) { console.error('[snapshot] restore failed:', e.message); }
}

// ---------------------------------------------------------------- upstreams: SRTT + circuit breaker
class Upstream {
  constructor(u) {
    this.name = u.name || u.address;
    this.address = u.address;
    // protocol: 'udp' (default) | 'tls' (DoT, RFC 7858) | 'https' (DoH, RFC 8484)
    this.protocol = (u.protocol || 'udp').toLowerCase();
    this.hostname = u.hostname || null;   // SNI + cert verification + Host header
    this.internal = !!u.internal;         // LAN-local: tighter timeout budget
    this.path = u.path || '/dns-query';   // DoH path
    this.port = u.port || (this.protocol === 'tls' ? 853 : this.protocol === 'https' ? 443 : 53);
    this.srtt = config.timeoutMs.initial; this.rttvar = config.timeoutMs.initial / 2;
    this.window = [];            // rolling booleans
    this.open = false;           // circuit open = do not use
    this.lastProbe = 0;
    this.sent = 0; this.failed = 0;
  }
  timeout() {
    const t = this.srtt + 4 * this.rttvar; // RFC 6298 flavor
    // LAN-local resolvers (router/DC) must fail fast — a 2.4s timeout per query becomes a
    // storm when something reverse-resolves a whole subnet.
    const max = this.internal ? (config.internalTimeoutMs || 700) : config.timeoutMs.max;
    return Math.max(config.timeoutMs.min, Math.min(max, t));
  }
  record(ok, rttMs) {
    this.window.push(ok);
    if (this.window.length > config.circuit.windowSize) this.window.shift();
    if (ok && rttMs != null) {
      // RFC 6298 smoothing
      const err = rttMs - this.srtt;
      this.srtt += 0.125 * err;
      this.rttvar += 0.25 * (Math.abs(err) - this.rttvar);
    }
    if (!ok) this.failed++;
    const fails = this.window.filter(x => !x).length;
    const rate = this.window.length ? fails / this.window.length : 0;
    if (!this.open && this.window.length >= 5 && rate >= config.circuit.failThreshold) {
      this.open = true;
      console.warn(`[circuit] OPEN for ${this.name} (fail rate ${(rate * 100).toFixed(0)}%)`);
    }
  }
  closeCircuit() {
    if (this.open) console.log(`[circuit] CLOSED for ${this.name} — healthy again`);
    this.open = false; this.window = [];
  }
}
let upstreams = config.upstreams.map(u => new Upstream(u));

function pickUpstreams() {
  const healthy = upstreams.filter(u => !u.open);
  const pool = healthy.length ? healthy : upstreams; // worst case: everything open, still try
  return [...pool].sort((a, b) => a.srtt - b.srtt);
}

// ---------------------------------------------------------------- encrypted upstream transports
// DoT/DoH connect by IP and use `hostname` for SNI + certificate verification + Host header.
// Connecting by IP avoids the bootstrap chicken-and-egg (no need to resolve the resolver).
const dotPool = new Map();   // upstream.name -> { sock, pending:Map<id,{resolve,reject,timer}>, buf }
function dotClose(key, err) {
  const e = dotPool.get(key);
  if (!e) return;
  dotPool.delete(key);
  try { e.sock.destroy(); } catch {}
  for (const [, p] of e.pending) { clearTimeout(p.timer); p.reject(err || new Error('DoT connection closed')); }
  e.pending.clear();
}
function dotConnect(up) {
  const key = up.name;
  const existing = dotPool.get(key);
  if (existing && !existing.sock.destroyed) return existing;
  const opts = { host: up.address, port: up.port, ALPNProtocols: ['dot'] };
  if (up.hostname) opts.servername = up.hostname; else opts.rejectUnauthorized = false;
  const sock = tls.connect(opts);
  const entry = { sock, pending: new Map(), buf: Buffer.alloc(0) };
  sock.setTimeout(30000, () => dotClose(key, new Error('DoT idle timeout')));
  sock.on('data', d => {
    entry.buf = Buffer.concat([entry.buf, d]);
    while (entry.buf.length >= 2) {
      const len = entry.buf.readUInt16BE(0);
      if (entry.buf.length < 2 + len) break;
      const msg = entry.buf.subarray(2, 2 + len);
      entry.buf = entry.buf.subarray(2 + len);
      let id = null;
      try { id = msg.readUInt16BE(0); } catch {}
      const p = id != null ? entry.pending.get(id) : null;
      if (p) { clearTimeout(p.timer); entry.pending.delete(id); p.resolve(msg); }
    }
  });
  sock.on('error', e => dotClose(key, e));
  sock.on('close', () => dotClose(key, new Error('DoT closed')));
  dotPool.set(key, entry);
  return entry;
}
function dotQuery(up, packet, timeoutMs) {
  return new Promise((resolve, reject) => {
    let entry;
    try { entry = dotConnect(up); } catch (e) { return reject(e); }
    const id = packet.readUInt16BE(0);
    if (entry.pending.has(id)) return reject(new Error('DoT id collision'));
    const timer = setTimeout(() => { entry.pending.delete(id); reject(new Error('timeout')); }, timeoutMs);
    entry.pending.set(id, { resolve, reject, timer });
    const framed = Buffer.alloc(2 + packet.length);
    framed.writeUInt16BE(packet.length, 0); packet.copy(framed, 2);
    const write = () => { try { entry.sock.write(framed); } catch (e) { clearTimeout(timer); entry.pending.delete(id); reject(e); } };
    if (entry.sock.connecting) entry.sock.once('secureConnect', write); else write();
  });
}

const dohAgents = new Map();
function dohAgent(up) {
  if (!dohAgents.has(up.name)) dohAgents.set(up.name, new https.Agent({ keepAlive: true, maxSockets: 8 }));
  return dohAgents.get(up.name);
}
function dohQuery(up, packet, timeoutMs) {
  return new Promise((resolve, reject) => {
    const opts = {
      host: up.address, port: up.port, path: up.path, method: 'POST',
      agent: dohAgent(up), timeout: timeoutMs,
      headers: { 'content-type': 'application/dns-message', 'accept': 'application/dns-message',
                 'content-length': packet.length }
    };
    if (up.hostname) { opts.servername = up.hostname; opts.headers.host = up.hostname; }
    else opts.rejectUnauthorized = false;
    const req = https.request(opts, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`DoH HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(packet);
  });
}

function upstreamQuery(up, packet) {
  // encrypted transports share the same SRTT / circuit-breaker accounting as UDP
  if (up.protocol === 'tls' || up.protocol === 'https') {
    const started = Date.now();
    const fn = up.protocol === 'tls' ? dotQuery : dohQuery;
    return fn(up, packet, up.timeout()).then(msg => {
      const rtt = Date.now() - started;
      let resp;
      try { resp = dnsPacket.decode(msg); } catch (e) { up.record(false); throw e; }
      if (resp.rcode === 'SERVFAIL' || resp.rcode === 'REFUSED') { up.record(false); throw new Error(resp.rcode); }
      up.record(true, rtt); up.sent++;
      return resp;
    }).catch(e => { up.record(false); throw e; });
  }
  return new Promise((resolve, reject) => {
    // socket family must match the upstream address, or IPv6 forwarders/DCs can never be reached
    const sock = dgram.createSocket(net.isIPv6(up.address) ? 'udp6' : 'udp4');
    const started = Date.now();
    const to = setTimeout(() => { sock.close(); up.record(false); reject(new Error('timeout')); }, up.timeout());
    sock.once('message', msg => {
      clearTimeout(to); sock.close();
      const rtt = Date.now() - started;
      try {
        const resp = dnsPacket.decode(msg);
        if (resp.rcode === 'SERVFAIL' || resp.rcode === 'REFUSED') {
          up.record(false); return reject(new Error(resp.rcode));
        }
        up.record(true, rtt);
        resolve(resp);
      } catch (e) { up.record(false); reject(e); }
    });
    sock.once('error', e => { clearTimeout(to); try { sock.close(); } catch {} up.record(false); reject(e); });
    up.sent++;
    sock.send(packet, up.port, up.address);
  });
}

// background prober re-closes open circuits
setInterval(async () => {
  for (const up of upstreams) {
    if (!up.open) continue;
    if (Date.now() - up.lastProbe < config.circuit.probeIntervalMs) continue;
    up.lastProbe = Date.now();
    const probe = dnsPacket.encode({
      type: 'query', id: Math.floor(Math.random() * 65535), flags: dnsPacket.RECURSION_DESIRED,
      questions: [{ type: 'A', name: 'example.com' }],
      additionals: [{ type: 'OPT', name: '.', udpPayloadSize: config.dns.ednsUdpSize }]
    });
    try { await upstreamQuery(up, probe); up.closeCircuit(); } catch {}
  }
}, 1000);

// ECS (EDNS Client Subnet, RFC 7871) option builder — opt-in only
function ecsOption(clientIP) {
  if (!clientIP || clientIP === '127.0.0.1' || clientIP.startsWith('::1')) return null;
  const v6 = clientIP.includes(':');
  const prefix = v6 ? (config.ecsPrefixV6 || 56) : (config.ecsPrefixV4 || 24);
  let addrBytes;
  if (v6) {
    // minimal: only handle full v6 by zero-padding first bytes per prefix
    const parts = clientIP.split('::');
    return null; // keep v6 ECS conservative/off unless explicitly extended
  } else {
    const octets = clientIP.split('.').map(Number);
    const nBytes = Math.ceil(prefix / 8);
    addrBytes = Buffer.from(octets.slice(0, nBytes));
  }
  const data = Buffer.alloc(4 + addrBytes.length);
  data.writeUInt16BE(v6 ? 2 : 1, 0);   // family
  data.writeUInt8(prefix, 2);          // source prefix
  data.writeUInt8(0, 3);               // scope prefix
  addrBytes.copy(data, 4);
  return { code: 8, data };
}

// ---------------------------------------------------------------- internal fallback (router) resolver
const { execSync } = require('child_process');
let internalFallbackUpstreams = [];
let _gatewayCache, _gatewayAt = 0;
function detectGateway() {
  // execSync spawns a subprocess — this was showing up at ~5% CPU because it ran on
  // every buildInternalFallback() (i.e. on every worker on every config save).
  if (_gatewayCache !== undefined && Date.now() - _gatewayAt < 300000) return _gatewayCache;
  _gatewayAt = Date.now();
  _gatewayCache = _detectGatewayUncached();
  return _gatewayCache;
}
function _detectGatewayUncached() {
  try {
    const out = execSync("ip route show default 2>/dev/null | awk '{print $3; exit}'", { encoding: 'utf8' }).trim();
    if (/^\d+\.\d+\.\d+\.\d+$/.test(out)) return out;
  } catch {}
  try { // BSD/macOS style fallback
    const out = execSync("netstat -rn 2>/dev/null | awk '/^default/{print $2; exit}'", { encoding: 'utf8' }).trim();
    if (/^\d+\.\d+\.\d+\.\d+$/.test(out)) return out;
  } catch {}
  return null;
}
// Guard: never forward to ourselves (would loop). Compare against our own bound addresses.
function isSelfAddress(ip) {
  if (!ip) return true;
  if (ip === '127.0.0.1' || ip === '::1' || ip === '0.0.0.0') return true;
  try {
    const os = require('os');
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of (list || [])) if (ni.address === ip) return true;
    }
  } catch {}
  return false;
}
// Register this resolver's own name so <hostname>.<internal zone> resolves instead of
// SERVFAILing through the fallback. Only fills gaps — never overwrites a user record.
function registerSelfRecord() {
  if (config.selfRecord === false) return;
  const os = require('os');
  const zones = config.internalZones || [];
  if (!zones.length) return;
  const host = (config.selfName || os.hostname() || '').split('.')[0].toLowerCase();
  if (!host) return;
  let v4 = null, v6 = null;
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of (list || [])) {
      if (ni.internal) continue;
      if (!v4 && ni.family === 'IPv4') v4 = ni.address;
      if (!v6 && ni.family === 'IPv6' && !ni.address.startsWith('fe80')) v6 = ni.address;
    }
  }
  config.localRecords = config.localRecords || [];
  let added = 0;
  for (const z of zones) {
    const fqdn = `${host}.${z}`;
    const has = t => config.localRecords.some(r => r.name.toLowerCase() === fqdn && r.type.toUpperCase() === t);
    if (v4 && !has('A'))   { config.localRecords.push({ name: fqdn, type: 'A',    data: v4, ttl: 3600 }); added++; }
    if (v6 && !has('AAAA')){ config.localRecords.push({ name: fqdn, type: 'AAAA', data: v6, ttl: 3600 }); added++; }
  }
  if (added) { saveConfig({ noBroadcast: true }); invalidateLocalIndex(); console.log(`[self] registered ${host}.{${zones.join(',')}} -> ${v4 || ''} ${v6 || ''}`); }
}

// Probe internal resolvers at boot so a wrong auto-detected gateway is obvious, not silent.
function probeInternalResolvers() {
  const probe = (up, label, testName) => {
    const pkt = dnsPacket.encode({
      type: 'query', id: Math.floor(Math.random() * 65535), flags: dnsPacket.RECURSION_DESIRED,
      questions: [{ type: 'A', name: testName }],
      additionals: [{ type: 'OPT', name: '.', udpPayloadSize: config.dns.ednsUdpSize }]
    });
    const sock = dgram.createSocket(net.isIPv6(up.address) ? 'udp6' : 'udp4');
    const to = setTimeout(() => { try { sock.close(); } catch {}
      console.warn(`[internal] ${label} ${up.address}:${up.port} did NOT answer — internal names in that zone will fail. Check the IP and that it serves DNS.`);
    }, 2500);
    sock.once('message', () => { clearTimeout(to); try { sock.close(); } catch {};
      console.log(`[internal] ${label} ${up.address}:${up.port} responding`); });
    sock.once('error', () => { clearTimeout(to); try { sock.close(); } catch {}; });
    try { sock.send(pkt, up.port, up.address); } catch { clearTimeout(to); }
  };
  for (const up of internalFallbackUpstreams) probe(up, 'fallback', 'example.com');
  for (const cf of condForwarders) for (const up of cf.upstreams) probe(up, `zone ${cf.zone} ->`, cf.zone);
}

function buildInternalFallback() {
  invalidatePeerCache();
  internalFallbackUpstreams = [];
  const cfg = config.internalFallback;
  if (cfg === false || cfg === undefined || cfg === null) return;
  let targets = [];
  if (cfg === 'auto') {
    const gw = detectGateway();
    if (gw && !isSelfAddress(gw)) targets = [{ name: 'router(auto)', address: gw, port: 53 }];
    else if (gw) console.warn(`[internal] auto-detected gateway ${gw} is this host — skipping fallback (loop guard)`);
    else console.warn('[internal] could not auto-detect a gateway; set internalFallback explicitly');
  } else if (Array.isArray(cfg)) {
    targets = cfg.filter(t => t && t.address && !isSelfAddress(t.address))
                 .map(t => ({ name: t.name || `internal(${t.address})`, address: t.address, port: t.port || 53 }));
  }
  internalFallbackUpstreams = targets.map(t => new Upstream({ ...t, internal: true }));
  _reverseUpstreams = null;   // rebuild on next use
  if (internalFallbackUpstreams.length)
    console.log(`[internal] unmatched internal names -> ${internalFallbackUpstreams.map(u => u.address).join(', ')}`);
}

// ---------------------------------------------------------------- forwarding loop prevention
// If a query arrives FROM a machine that we forward to (the router, a DC), we must never
// forward it back — that is a mutual-forwarding loop and produces 2s+ timeout storms.
// Peers are every address we forward to, plus anything the user declares in config.loopPeers
// (use that for a device's other addresses, e.g. the router's IPv6).
function normAddr(a) { return String(a || '').replace(/^::ffff:/i, '').toLowerCase(); }
let _peerCache = null;
function invalidatePeerCache() { _peerCache = null; }
function peerResolverAddresses() {
  if (_peerCache) return _peerCache;
  const set = new Set();
  const add = a => { if (a) set.add(normAddr(a)); };
  for (const cf of (config.conditionalForwarders || [])) for (const u of (cf.upstreams || [])) add(u.address);
  if (Array.isArray(config.internalFallback)) for (const u of config.internalFallback) add(u.address);
  for (const u of internalFallbackUpstreams) add(u.address);
  for (const u of (config.reverseForwarders || [])) add(u.address);
  for (const a of (config.loopPeers || [])) add(a);
  _peerCache = set;
  return set;
}
function isPeerResolver(clientIP) {
  if (config.forwardLoopGuard === false) return false;
  return peerResolverAddresses().has(normAddr(clientIP));
}
// Drop any upstream that is the client itself (direct self-forward).
function withoutClient(ups, clientIP) {
  const c = normAddr(clientIP);
  return (ups || []).filter(u => normAddr(u.address) !== c);
}

// ---------------------------------------------------------------- reverse DNS (PTR) for private ranges
// AD-joined machines rely on reverse lookups. A PTR for an RFC1918 address must go to the internal
// resolver (DC or router), never to a public upstream — that both leaks and fails.
function ptrIsPrivate(qname) {
  const n = String(qname).toLowerCase().replace(/\.$/, '');
  if (n.endsWith('.in-addr.arpa')) {
    const parts = n.slice(0, -'.in-addr.arpa'.length).split('.').reverse().map(Number);
    if (parts.some(isNaN)) return false;
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (n.endsWith('.ip6.arpa')) {
    // ULA fc00::/7 and link-local fe80::/10 reversed nibbles end with c.f / d.f / 8.e.f etc.
    return /(^|\.)(c\.f|d\.f|[89ab]\.e\.f)\.ip6\.arpa$/.test(n);
  }
  return false;
}
// Which upstreams should answer a private PTR: an explicit reverse forwarder, else the DC
// forwarders we know about, else the internal fallback (router).
let _reverseUpstreams = null, _heapSampleN = 0;
function buildReverseUpstreams() {
  _reverseUpstreams = (Array.isArray(config.reverseForwarders) && config.reverseForwarders.length)
    ? config.reverseForwarders.map(u => new Upstream({ ...u, internal: true }))
    : null;
}
function reverseUpstreams() {
  // Built once, not per query — otherwise a reverse-DNS sweep of a /24 allocates hundreds
  // of Upstream objects and discards all health/SRTT state each time.
  if (_reverseUpstreams === null && Array.isArray(config.reverseForwarders) && config.reverseForwarders.length) buildReverseUpstreams();
  if (_reverseUpstreams && _reverseUpstreams.length) return _reverseUpstreams;
  if (internalFallbackUpstreams.length) return internalFallbackUpstreams;
  return [];
}

// ---------------------------------------------------------------- internal zones + conditional forwarding
let condForwarders = [];   // [{ zone, upstreams:[Upstream] }]
function buildCondForwarders() {
  invalidatePeerCache();
  invalidateCategoryIndex();
  invalidateLocalIndex();
  condForwarders = (config.conditionalForwarders || []).map(cf => ({
    zone: String(cf.zone).toLowerCase().replace(/\.$/, ''),
    upstreams: (cf.upstreams || []).map(u => new Upstream({ ...u, internal: true }))
  }));
}
function matchConditionalForwarder(qname) {
  let best = null;
  for (const cf of condForwarders) {
    if (qname === cf.zone || qname.endsWith('.' + cf.zone)) {
      if (!best || cf.zone.length > best.zone.length) best = cf; // longest-suffix wins
    }
  }
  return best;
}
function isInternalZone(qname) {
  for (const z of (config.internalZones || [])) {
    const zz = String(z).toLowerCase().replace(/\.$/, '');
    if (qname === zz || qname.endsWith('.' + zz)) return zz;
  }
  return null;
}

// ---------------------------------------------------------------- resolution w/ coalescing
const inflight = new Map(); // key -> Promise

// QNAME minimization (RFC 9156).
// This resolver forwards to upstreams that already perform QNAME minimization (Cloudflare, Quad9),
// so in normal forwarding mode minimization is delegated — the full qname never reaches an
// authoritative server directly from us. When config.qnameMinimization is false we note it in
// stats so the behavior is observable rather than silent. The helper below backs the internal
// iterative path used for conditional forwarders where we DO control label exposure.
function qnameLabels(name){ return String(name).replace(/\.$/,'').split('.').filter(Boolean); }
function minimalLabel(name, depth){
  const l = qnameLabels(name);
  if (depth >= l.length) return name;
  return l.slice(l.length - depth - 1).join('.');
}

async function resolveUpstream(question, forcedUpstreams, clientIP) {
  const key = cacheKey(question) + (forcedUpstreams ? '|cf' : '');
  if (inflight.has(key)) { stats.coalesced++; return inflight.get(key); }
  const p = (async () => {
    const wireName = config.caseRandomization === false ? question.name : randomizeCase(question.name);
    const mkPacket = up => dnsPacket.encode({
      type: 'query', id: Math.floor(Math.random() * 65535), flags: dnsPacket.RECURSION_DESIRED,
      questions: [{ type: question.type, name: wireName }],
      additionals: [{ type: 'OPT', name: '.', udpPayloadSize: config.dns.ednsUdpSize,
        flags: config.dnssec !== 'off' ? 32768 : 0,   // DO bit
        options: (() => { const o = up ? [cookieOption(up)] : []; if (config.ecs === true) { const e = ecsOption(clientIP); if (e) o.push(e); } if (config.dnsCookies === false && up) o.shift(); return o; })() }]
    });
    const order = forcedUpstreams && forcedUpstreams.length ? [...forcedUpstreams].sort((a,b)=>a.srtt-b.srtt) : pickUpstreams();
    if (config.race && order.length >= 2) {
      try {
        const r = await Promise.any([upstreamQuery(order[0], mkPacket(order[0])), upstreamQuery(order[1], mkPacket(order[1]))]);
        if (config.caseRandomization === false || !r.questions || !r.questions[0] || r.questions[0].name === wireName) return r;
      } catch {} // fall through to sequential over the rest
    }
    const verify = resp => {
      // 0x20 verification: upstream must echo our exact mixed-case qname or the reply is suspect
      if (config.caseRandomization !== false && resp.questions && resp.questions[0] &&
          resp.questions[0].name !== wireName) throw new Error('0x20 case mismatch - possible spoof');
      return resp;
    };
    let lastErr = new Error('no upstreams');
    let first = true;
    for (const up of order) {
      if (!first) await new Promise(r => setTimeout(r, Math.random() * 60)); // jittered failover: no retry storms
      first = false;
      try {
        const resp = verify(await upstreamQuery(up, mkPacket(up)));
        storeServerCookie(up, resp);
        return resp;
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

function minTtl(answers) {
  let t = Infinity;
  for (const a of answers) t = Math.min(t, a.ttl ?? 300);
  return t === Infinity ? 300 : t;
}

// prefetch: hot entries close to expiry get refreshed in the background
setInterval(() => {
  if (!config.cache.prefetch) return;
  const now = Date.now();
  let budget = 20;
  for (const [key, e] of cache) {
    if (budget <= 0) break;
    const remaining = (e.expiresAt - now) / 1000;
    if (remaining > 0 && remaining < config.cache.prefetchWindow && e.hits >= 3) {
      const [name, type] = key.split('|');
      budget--;
      stats.prefetches++;
      resolveUpstream({ name, type }).then(resp => {
        const answers = normalizeAnswers((resp.answers || []).filter(a => a.type !== 'OPT'));
        cacheSet(key, resp.rcode, answers, minTtl(answers));
      }).catch(() => {}); // failure never cached; entry ages into serve-stale naturally
    }
  }
}, 2000);

// ---------------------------------------------------------------- ACL + rate limit
function ipToLong(ip) { return ip.split('.').reduce((a, o) => (a << 8) + (+o), 0) >>> 0; }
function inCidr(ip, cidr) {
  if (!ip.includes('.')) return true; // v6 clients pass ACL in v1 (extend later)
  const [net_, bits] = cidr.split('/');
  const mask = bits === '0' ? 0 : (~0 << (32 - +bits)) >>> 0;
  return (ipToLong(ip) & mask) === (ipToLong(net_) & mask);
}
function aclAllows(ip) {
  const acl = config.clientAcl || [];
  if (!acl.length) return true;
  return acl.some(c => inCidr(ip, c));
}
const rateBuckets = new Map();
setInterval(() => rateBuckets.clear(), 1000);
function rateLimited(ip) {
  const limit = config.rateLimitPerClientQps;
  if (!limit) return false;
  const n = (rateBuckets.get(ip) || 0) + 1;
  rateBuckets.set(ip, n);
  return n > limit;
}

// ---------------------------------------------------------------- uklans cache_domains importer
const UKLANS_BASE = 'https://raw.githubusercontent.com/uklans/cache-domains/master';
async function importUklans() {
  const index = JSON.parse(await fetchUrl(`${UKLANS_BASE}/cache_domains.json`, 20000));
  const results = {};
  for (const svc of index.cache_domains || []) {
    const domains = new Set();
    for (const f of svc.domain_files || []) {
      try {
        const txt = await fetchUrl(`${UKLANS_BASE}/${f}`, 15000);
        for (let line of txt.split('\n')) {
          line = line.trim().toLowerCase();
          if (!line || line.startsWith('#')) continue;
          line = line.replace(/^\*\./, '');           // suffix matching already covers wildcards
          if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(line)) domains.add(line);
        }
      } catch (e) { console.error(`[uklans] ${f}: ${e.message}`); }
    }
    if (!domains.size) continue;
    const existing = config.categories[svc.name];
    config.categories[svc.name] = {
      enabled: existing ? existing.enabled : true,
      target: (existing && existing.target) ? existing.target : (config.defaultCacheTarget || ''),
      target6: (existing && existing.target6) ? existing.target6 : '',
      domains: [...domains]
    };
    results[svc.name] = domains.size;
  }
  saveConfig();
  invalidateCategoryIndex();
  console.log('[uklans] imported:', Object.entries(results).map(([k, v]) => `${k}=${v}`).join(' '));
  return results;
}

// ---------------------------------------------------------------- per-client subnet policies
// config.subnetPolicies: [{ cidr, disableCategories: [names], blockAll: bool, bypassBlocklist: bool }]
function policyForClient(ip) {
  for (const p of (config.subnetPolicies || [])) {
    if (inCidr(ip, p.cidr)) return p;
  }
  return null;
}

// ---------------------------------------------------------------- block page server
// blockedResponse: 'nxdomain' | 'zeroip' | 'blockpage' (rewrites A to this host's IP; HTTP below serves the reason)
const blockReasons = new Map(); // domain -> { reason, at } (recent blocks, for page lookup)
const BLOCK_REASONS_MAX = 2000;
function noteBlock(domain, reason) {
  // Hard cap, LRU-style. Time-based expiry alone was unbounded: ad/tracker domains often
  // use unique random subdomains, so a burst produced thousands of entries all newer than
  // the cutoff and nothing was ever evicted.
  if (blockReasons.has(domain)) blockReasons.delete(domain);   // re-insert = move to newest
  blockReasons.set(domain, { reason, at: Date.now() });
  while (blockReasons.size > BLOCK_REASONS_MAX) {
    const oldest = blockReasons.keys().next().value;           // Map preserves insertion order
    if (oldest === undefined) break;
    blockReasons.delete(oldest);
  }
}
let blockPageServer = null;
function startBlockPage() {
  const port = config.blockPagePort || 8053;
  blockPageServer = http.createServer((req, res) => {
    const host = (req.headers.host || '').split(':')[0].toLowerCase();
    const info = blockReasons.get(host);
    const reason = info ? info.reason : 'blocked by network policy';
    res.writeHead(info ? 451 : 404, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Blocked</title><style>
body{background:#0b0e14;color:#dbe2f0;font:15px ui-monospace,monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#131824;border:1px solid #212a3d;border-radius:12px;padding:32px 40px;max-width:520px}
h1{font-size:18px;margin:0 0 8px;color:#ff5d6c}.d{color:#4da3ff}.r{color:#7d8aa5;font-size:13px;margin-top:10px}
</style></head><body><div class="card"><h1>⛔ Blocked</h1>
<div><span class="d">${host || 'this domain'}</span> was blocked by StellarDNS.</div>
<div class="r">Reason: ${reason}</div></div></body></html>`);
  });
  blockPageServer.listen(port, config.dns.host, () => console.log(`[blockpage] serving on :${port}`));
}


// ---------------------------------------------------------------- EDE, DNS Cookies, rebinding protection
const EDE = { OTHER: 0, STALE: 3, DNSSEC_BOGUS: 6, BLOCKED: 15, CENSORED: 16, FILTERED: 17, PROHIBITED: 18, NOT_SUPPORTED: 21 };
function edeOption(infoCode, text) {
  const t = Buffer.from(text || '', 'utf8');
  const data = Buffer.alloc(2 + t.length);
  data.writeUInt16BE(infoCode, 0); t.copy(data, 2);
  return { code: 15, data }; // option-code 15 = Extended DNS Error (RFC 8914)
}
function cookieOption(up) {
  if (!up._clientCookie) up._clientCookie = crypto.randomBytes(8);
  const data = up._serverCookie ? Buffer.concat([up._clientCookie, up._serverCookie]) : up._clientCookie;
  return { code: 10, data }; // option-code 10 = DNS Cookie (RFC 7873)
}
function storeServerCookie(up, resp) {
  try {
    for (const add of (resp.additionals || [])) {
      if (add.type !== 'OPT') continue;
      for (const opt of (add.options || [])) {
        const code = opt.code === 'COOKIE' ? 10 : opt.code;
        if (code === 10 && opt.data && opt.data.length > 8) up._serverCookie = opt.data.subarray(8);
      }
    }
  } catch {}
}
function isPrivateIp(ip) {
  if (ip.includes(':')) {
    const l = ip.toLowerCase();
    return l === '::1' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe8') || l.startsWith('fe9') || l.startsWith('fea') || l.startsWith('feb');
  }
  const o = ip.split('.').map(Number);
  return o[0] === 10 || o[0] === 127 || o[0] === 0 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) ||
         (o[0] === 192 && o[1] === 168) || (o[0] === 169 && o[1] === 254);
}
function rebindingAllowed(qname) {
  if (config.rebindingProtection === false) return true;
  if (matchCategory(qname)) return true;                                  // our own rewrites resolve private on purpose
  if ((config.localRecords || []).some(r => qname === r.name.toLowerCase() || qname.endsWith('.' + r.name.toLowerCase()))) return true;
  if (rebindAllowSet === null) rebindAllowSet = new Set((config.rebindingAllow || config.rebindingAllowlist || []).map(x => String(x).toLowerCase()));
  if (rebindAllowSet.size && firstSuffixMatch(qname, s => rebindAllowSet.has(s))) return true;
  return false;
}

// ---------------------------------------------------------------- TLS certs (self-signed autogen), DoT, DoH
const tls = require('tls');
const { execFileSync } = require('child_process');
const CERT = path.join(DATA_DIR, 'tls.crt'), KEY = path.join(DATA_DIR, 'tls.key');
function ensureCert() {
  if (fs.existsSync(CERT) && fs.existsSync(KEY)) return true;
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', KEY, '-out', CERT,
      '-days', '3650', '-nodes', '-subj', '/CN=stellardns', '-addext', 'subjectAltName=DNS:stellardns,DNS:stellardns.lan'], { stdio: 'ignore' });
    console.log('[tls] generated self-signed cert in', DATA_DIR);
    return true;
  } catch (e) { console.error('[tls] openssl unavailable - DoT/DoH disabled:', e.message); return false; }
}
function startDot() {
  if (config.dot === false) return;
  if (!ensureCert()) return;
  const port = config.dotPort || 853;
  const srv = tls.createServer({ cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) }, sock => {
    let buf = Buffer.alloc(0);
    sock.on('data', async d => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2) {
        const len = buf.readUInt16BE(0);
        if (buf.length < 2 + len) break;
        const msg = buf.subarray(2, 2 + len);
        buf = buf.subarray(2 + len);
        stats.dotQueries = (stats.dotQueries || 0) + 1;
        const out = await handleQuery(msg, { client: (sock.remoteAddress || '?').replace('::ffff:', ''), proto: 'dot' });
        if (out) {
          const framed = Buffer.alloc(2 + out.length);
          framed.writeUInt16BE(out.length, 0); out.copy(framed, 2);
          sock.write(framed);
        }
      }
    });
    sock.on('error', () => {});
    sock.setTimeout(15000, () => sock.destroy());
  });
  srv.on('error', e => console.error('[dot]', e.message));
  const dotHost = (config.dns.host === '0.0.0.0' && config.dns.host6) ? '::' : config.dns.host;
  srv.listen(port, dotHost, () => { if (!cluster.worker || cluster.worker.id === 1) console.log(`[dot] DNS-over-TLS on :${port} (${dotHost})`); });
}
function startDoh() {
  if (config.doh === false) return;
  if (!ensureCert()) return;
  const port = config.dohPort || 8443;
  const srv = https.createServer({ cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) }, async (req, res) => {
    const u = new URL(req.url, 'https://x');
    if (u.pathname !== '/dns-query') { res.writeHead(404); return res.end(); }
    let msg = null;
    if (req.method === 'GET' && u.searchParams.get('dns')) {
      msg = Buffer.from(u.searchParams.get('dns').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    } else if (req.method === 'POST') {
      const chunks = []; for await (const c of req) chunks.push(c);
      msg = Buffer.concat(chunks);
    }
    if (!msg || !msg.length) { res.writeHead(400); return res.end(); }
    stats.dohQueries = (stats.dohQueries || 0) + 1;
    const out = await handleQuery(msg, { client: (req.socket.remoteAddress || '?').replace('::ffff:', ''), proto: 'doh' });
    if (!out) { res.writeHead(500); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/dns-message', 'Cache-Control': 'max-age=0' });
    res.end(out);
  });
  srv.on('error', e => console.error('[doh]', e.message));
  const dohHost = (config.dns.host === '0.0.0.0' && config.dns.host6) ? '::' : config.dns.host;
  srv.listen(port, dohHost, () => { if (!cluster.worker || cluster.worker.id === 1) console.log(`[doh] DNS-over-HTTPS on :${port}/dns-query (${dohHost})`); });
}

// ---------------------------------------------------------------- 0x20 qname case randomization (anti-spoofing)
function randomizeCase(name) {
  let out = '';
  for (const ch of name) out += (/[a-z]/i.test(ch) && Math.random() < 0.5) ? (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()) : ch;
  return out;
}
function normalizeAnswers(answers) {
  for (const a of answers) {
    if (a.name) a.name = String(a.name).toLowerCase();
    if ((a.type === 'CNAME' || a.type === 'NS' || a.type === 'PTR') && typeof a.data === 'string') a.data = a.data.toLowerCase();
  }
  return answers;
}

// ---------------------------------------------------------------- raw EDNS option injection (EDE / Cookie)
// dns-packet lacks encoders for EDE(15) and COOKIE(10); we append raw option bytes to the OPT RR.
function appendEdnsOptions(wire, rawOptions) {
  // rawOptions: [{ code, data:Buffer }]
  if (!rawOptions || !rawOptions.length) return wire;
  try {
    const msg = dnsPacket.decode(wire);
    // find OPT in additionals; dns-packet re-encodes cleanly, so we splice at wire level instead.
    // Simpler & robust: rebuild OPT rdata manually by decoding, dropping OPT, re-encoding, then appending our OPT.
    const opt = (msg.additionals || []).find(a => a.type === 'OPT');
    const udpSize = opt ? opt.udpPayloadSize : config.dns.ednsUdpSize;
    const extendedRcode = 0, version = 0, flags = 0;
    // build option blob
    let optData = Buffer.alloc(0);
    for (const o of rawOptions) {
      const h = Buffer.alloc(4);
      h.writeUInt16BE(o.code, 0);
      h.writeUInt16BE(o.data.length, 2);
      optData = Buffer.concat([optData, h, o.data]);
    }
    // OPT RR: name=root(0x00) type=41 class=udpSize ttl=(extRcode<<24|ver<<16|flags) rdlen rdata
    const rr = Buffer.alloc(11 + optData.length);
    let off = 0;
    rr.writeUInt8(0, off); off += 1;                 // root name
    rr.writeUInt16BE(41, off); off += 2;             // OPT
    rr.writeUInt16BE(udpSize, off); off += 2;        // class = UDP size
    rr.writeUInt32BE(((extendedRcode & 0xff) << 24) | ((version & 0xff) << 16) | (flags & 0xffff), off); off += 4;
    rr.writeUInt16BE(optData.length, off); off += 2; // rdlen
    optData.copy(rr, off);
    // strip existing OPT from message, re-encode without it, then append our OPT and bump ARCOUNT
    msg.additionals = (msg.additionals || []).filter(a => a.type !== 'OPT');
    const base = dnsPacket.encode(msg);
    const out = Buffer.concat([base, rr]);
    out.writeUInt16BE((msg.additionals.length) + 1, 10); // ARCOUNT at offset 10
    return out;
  } catch { return wire; }
}
// ---------------------------------------------------------------- DNS rebinding protection
function isPrivateIP(ip) {
  if (!ip) return false;
  if (ip.includes(':')) { // IPv6 ULA/link-local/loopback
    const l = ip.toLowerCase();
    return l === '::1' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:0') || l === '::';
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4) return false;
  return p[0] === 10 || p[0] === 127 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
         (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254) || p[0] === 0;
}
// A name is exempt from rebinding protection if it's one of ours (rewrite target, local record,
// internal zone suffix, or explicit allowlist) — those are SUPPOSED to resolve to private IPs.
function rebindingExempt(qname) {
  if (matchCategory(qname)) return true;                       // LANCache rewrites
  if (!localNameList) buildLocalIndex();                     // local authoritative
  for (let i = 0; i < localNameList.length; i++) {
    const n = localNameList[i];
    if (qname === n) return true;
    if (qname.length > n.length && qname.charCodeAt(qname.length - n.length - 1) === 46
        && qname.endsWith(n)) return true;
  }
  const izs = config.internalZones || [];                    // e.g. ['lan','internal','home.arpa']
  for (let i = 0; i < izs.length; i++) {
    const suf = izs[i];
    if (qname === suf) return true;
    if (qname.length > suf.length && qname.charCodeAt(qname.length - suf.length - 1) === 46
        && qname.endsWith(suf)) return true;
  }
  for (const suf of (config.rebindingAllowlist || [])) {
    if (qname === suf || qname.endsWith('.' + suf)) return true;
  }
  return false;
}

// ---------------------------------------------------------------- request handling
function buildAnswers(question, entry) {
  return entry.answers.map(a => ({ ...a }));
}

async function handleQuery(msg, meta) {
  let query;
  try { query = dnsPacket.decode(msg); } catch { return null; }
  if (!query.questions || !query.questions.length) return null;
  const q = { name: query.questions[0].name.toLowerCase(), type: query.questions[0].type };
  stats.queries++;
  const t0 = Date.now();
  const respond = (rcode, answers, disp, edeOpt, adFlag) => {
    logQuery({ t: Date.now(), client: meta.client, name: q.name, type: q.type, rcode, disp, ms: Date.now() - t0 });
    const RCODES = { NOERROR: 0, FORMERR: 1, SERVFAIL: 2, NXDOMAIN: 3, NOTIMP: 4, REFUSED: 5 };
    let flags = dnsPacket.RECURSION_DESIRED | dnsPacket.RECURSION_AVAILABLE
      | (dnsPacket.AUTHORITATIVE_ANSWER * (disp === 'local' || (disp || '').startsWith('rewrite') ? 1 : 0))
      | (RCODES[rcode] ?? 0)
      | (adFlag ? dnsPacket.AUTHENTIC_DATA : 0);
    let wire = dnsPacket.encode({
      type: 'response', id: query.id, flags,
      questions: query.questions,
      answers: answers || [],
      additionals: [{ type: 'OPT', name: '.', udpPayloadSize: config.dns.ednsUdpSize }]
    });
    if (edeOpt) wire = appendEdnsOptions(wire, [edeOpt]);   // raw-append EDE (dns-packet can't encode it)
    return wire;
  };

  if (!aclAllows(meta.client)) { stats.aclDenied++; return respond('REFUSED', [], 'acl'); }
  if (rateLimited(meta.client)) { stats.rateLimited++; return respond('REFUSED', [], 'ratelimit'); }

  // 0) DoH canary — tell Firefox to use us, not its built-in DoH
  if (config.dohCanaryNxdomain && (q.name === 'use-application-dns.net' || q.name.endsWith('.use-application-dns.net'))) {
    return respond('NXDOMAIN', [], 'doh-canary');
  }

  const clientPolicy = policyForClient(meta.client);
  if (clientPolicy && clientPolicy.blockAll) { stats.blocked++; return respond('NXDOMAIN', [], 'policy:blockAll', edeOption(EDE.PROHIBITED, 'blocked for this device group')); }

  // 1) Triage: local authoritative records
  const local = matchLocal(q.name, q.type);
  if (local) {
    stats.local++;
    const answers = local.typed.map(r => ({ name: q.name, type: r.type.toUpperCase(), ttl: r.ttl || 3600, data: r.data }));
    return respond('NOERROR', answers, 'local'); // NODATA if type mismatch: NOERROR + empty
  }

  // 1.4) Private reverse lookups (PTR) — send to internal resolvers, never public
  if (q.type === 'PTR' && ptrIsPrivate(q.name)) {
    // Loop guard: a peer resolver asking US for a private PTR must get an answer or a clean
    // NXDOMAIN — never a bounce back to itself.
    if (isPeerResolver(meta.client)) {
      return respond('NXDOMAIN', [], 'ptr-loopguard', edeOption(EDE.NOT_SUPPORTED, 'no reverse data here'));
    }
    const rUps = withoutClient(reverseUpstreams(), meta.client);
    const rKey = cacheKey(q);
    const rHit = cacheGet(rKey);
    if (rHit && !rHit.stale) { stats.cacheHits++; return respond(rHit.entry.rcode, buildAnswers(q, rHit.entry), 'cache-ptr'); }
    if (!rUps.length) return respond('NXDOMAIN', [], 'ptr-private-no-resolver', edeOption(EDE.NOT_SUPPORTED, 'no internal resolver for private PTR'));
    try {
      const resp = await resolveUpstream(q, rUps, meta.client);
      const answers = normalizeAnswers((resp.answers || []).filter(a => a.type !== 'OPT'));
      cacheSet(rKey, resp.rcode, answers, minTtl(answers));
      return respond(resp.rcode, answers, 'ptr-internal');
    } catch (e) {
      stats.servfail++;
      return respond('SERVFAIL', [], `ptr-internal-fail:${e.message}`, edeOption(EDE.OTHER, 'internal reverse resolver unreachable'));
    }
  }

  // 1.5) Internal zones: conditional-forward to AD/internal DNS, or NXDOMAIN (never leak to public)
  const cf = matchConditionalForwarder(q.name);
  if (cf) {
    stats.local++;
    const cfKey = cacheKey(q);
    const cHit = cacheGet(cfKey);
    if (cHit && !cHit.stale) { stats.cacheHits++; return respond(cHit.entry.rcode, buildAnswers(q, cHit.entry), 'cache-internal'); }
    try {
      const cfUps = withoutClient(cf.upstreams, meta.client);
      if (!cfUps.length) return respond('NXDOMAIN', [], `forward-loopguard:${cf.zone}`, edeOption(EDE.NOT_SUPPORTED, 'forward loop avoided'));
      const resp = await resolveUpstream(q, cfUps, meta.client);
      const answers = normalizeAnswers((resp.answers || []).filter(a => a.type !== 'OPT'));
      cacheSet(cfKey, resp.rcode, answers, minTtl(answers));
      return respond(resp.rcode, answers, `forward:${cf.zone}`);
    } catch (e) {
      if (cHit && cHit.stale) { stats.cacheStale++; return respond(cHit.entry.rcode, buildAnswers(q, cHit.entry), 'stale-internal'); }
      stats.servfail++;
      return respond('SERVFAIL', [], `internal-fail:${e.message}`);
    }
  }
  const internalZone = isInternalZone(q.name);
  if (internalZone) {
    // No conditional forwarder and no local record. Ask the internal fallback resolver
    // (normally the router/firewall — OPNsense Unbound is authoritative for names like
    // speedtest.internal). Only if that has nothing do we NXDOMAIN. We still never send
    // internal names to PUBLIC upstreams.
    // Loop guard: if the asker is itself one of our forwarders (router/DC), answering
    // "I don't know" immediately is correct — bouncing back would loop.
    if (isPeerResolver(meta.client)) {
      stats.blocked++;
      return respond('NXDOMAIN', [], `internal-loopguard:${internalZone}`, edeOption(EDE.NOT_SUPPORTED, 'internal zone, no record'));
    }
    const ifUps = withoutClient(internalFallbackUpstreams, meta.client);
    if (ifUps.length) {
      const ikey = cacheKey(q);
      const iHit = cacheGet(ikey);
      if (iHit && !iHit.stale) { stats.cacheHits++; return respond(iHit.entry.rcode, buildAnswers(q, iHit.entry), 'cache-internal'); }
      try {
        const resp = await resolveUpstream(q, ifUps, meta.client);
        const answers = normalizeAnswers((resp.answers || []).filter(a => a.type !== 'OPT'));
        cacheSet(ikey, resp.rcode, answers, minTtl(answers));
        return respond(resp.rcode, answers, `internal-router:${internalZone}`);
      } catch (e) {
        if (iHit && iHit.stale) { stats.cacheStale++; return respond(iHit.entry.rcode, buildAnswers(q, iHit.entry), 'stale-internal'); }
        stats.servfail++;
        return respond('SERVFAIL', [], `internal-router-fail:${e.message}`, edeOption(EDE.OTHER, 'internal resolver unreachable'));
      }
    }
    stats.blocked++;
    return respond('NXDOMAIN', [], `internal-nxdomain:${internalZone}`, edeOption(EDE.NOT_SUPPORTED, 'internal zone, no record'));
  }

  // 2) Triage: category rewrites (LANCache et al) — short-circuits everything below
  const catMatch = matchCategory(q.name);
  if (catMatch) {
    const { cat, conf } = catMatch;
    stats.perCategory[cat] = (stats.perCategory[cat] || 0) + 1;
    const disabledForClient = clientPolicy && Array.isArray(clientPolicy.disableCategories) && clientPolicy.disableCategories.includes(cat);
    if (!conf.enabled || disabledForClient) {
      stats.blocked++;
      noteBlock(q.name, disabledForClient ? `launcher '${cat}' disabled for your device group` : `launcher '${cat}' is turned off`);
      return respond('NXDOMAIN', [], `launcher-off:${cat}`, edeOption(EDE.BLOCKED, `launcher '${cat}' disabled`));
    }
    if (conf.target || conf.target6) {
      stats.rewrites++;
      const answers = [];
      if (q.type === 'A' && conf.target) answers.push({ name: q.name, type: 'A', ttl: 300, data: conf.target });
      if (q.type === 'AAAA' && conf.target6) answers.push({ name: q.name, type: 'AAAA', ttl: 300, data: conf.target6 });
      // AAAA query with only v4 target configured → NODATA, forcing client to v4 → the cache box
      return respond('NOERROR', answers, `rewrite:${cat}`);
    }
    // enabled but no target set: fall through to normal resolution
  }

  // 3) Triage: blocklist (checked on qname; CNAME chain checked post-resolution below)
  const blockedBy = (clientPolicy && clientPolicy.bypassBlocklist) ? null : isBlocked(q.name);
  if (blockedBy) {
    stats.blocked++;
    noteBlock(q.name, `matched blocklist entry '${blockedBy}'`);
    if (config.blockedResponse === 'blockpage' && config.blockPageIP && q.type === 'A') {
      return respond('NOERROR', [{ name: q.name, type: 'A', ttl: 60, data: config.blockPageIP }], `blocked:${blockedBy}`);
    }
    if (config.blockedResponse === 'zeroip' && (q.type === 'A' || q.type === 'AAAA')) {
      const data = q.type === 'A' ? '0.0.0.0' : '::';
      return respond('NOERROR', [{ name: q.name, type: q.type, ttl: 300, data }], `blocked:${blockedBy}`);
    }
    return respond('NXDOMAIN', [], `blocked:${blockedBy}`, edeOption(EDE.FILTERED, `blocklist: ${blockedBy}`));
  }

  // 3.5) AAAA filtering for public names (IPv6 path avoidance)
  if (q.type === 'AAAA' && config.filterAAAA) {
    const applies = config.filterAAAA === true ||
      (Array.isArray(config.filterAAAA) && config.filterAAAA.some(c => inCidr(meta.client, c)));
    if (applies) {
      stats.aaaaFiltered = (stats.aaaaFiltered || 0) + 1;
      // NODATA (NOERROR, no answers) — the correct way to say "no IPv6 here";
      // clients fall back to A immediately. NXDOMAIN would be wrong and cacheable as failure.
      return respond('NOERROR', [], 'aaaa-filtered', edeOption(EDE.FILTERED, 'AAAA filtered by policy'));
    }
  }

  // 4) Cache
  const key = cacheKey(q);
  const hit = cacheGet(key);
  if (hit && !hit.stale) {
    stats.cacheHits++;
    return respond(hit.entry.rcode, buildAnswers(q, hit.entry), 'cache', null, hit.entry.ad);
  }

  // 5) Upstream (coalesced) — with serve-stale on failure
  stats.cacheMiss++;
    // Happy Eyeballs assist: warm the sibling record (A<->AAAA) so a client racing v4/v6
    // connections has both answers cached and a slow IPv6 path can't stall future lookups.
    if (config.happyEyeballs === true && (q.type === 'A' || q.type === 'AAAA')) {
      const sib = q.type === 'A' ? 'AAAA' : 'A';
      const sibKey = `${q.name}|${sib}`;
      if (!cacheGet(sibKey)) {
        resolveUpstream({ name: q.name, type: sib }, null, meta.client).then(r => {
          const a = normalizeAnswers((r.answers || []).filter(x => x.type !== 'OPT'));
          cacheSet(sibKey, r.rcode, a, minTtl(a));
        }).catch(() => {}); // never blocks the primary answer; failure not cached
      }
    }
  try {
    const resp = await resolveUpstream(q, null, meta.client);
    const answers = normalizeAnswers((resp.answers || []).filter(a => a.type !== 'OPT'));
    // CNAME cloaking: if any CNAME in the chain lands on a blocked domain, block the whole answer
    for (const a of answers) {
      if (a.type === 'CNAME' && isBlocked(String(a.data).toLowerCase())) {
        stats.blocked++;
        return respond('NXDOMAIN', [], `blocked-cname:${a.data}`, edeOption(EDE.FILTERED, `cname-cloak: ${a.data}`));
      }
    }
    // DNS rebinding protection: external name resolving to a private IP, and not one of ours
    for (const a of answers) {
      if ((a.type === 'A' || a.type === 'AAAA') && isPrivateIp(String(a.data)) && !rebindingAllowed(q.name)) {
        stats.rebindBlocked = (stats.rebindBlocked || 0) + 1;
        noteBlock(q.name, `rebinding protection: resolved to private IP ${a.data}`);
        return respond('NXDOMAIN', [], `rebind-blocked:${a.data}`, edeOption(EDE.PROHIBITED, 'rebinding protection'));
      }
    }
    const ad = config.dnssec !== 'off' && !!(resp.flags & dnsPacket.AUTHENTIC_DATA);
    // strict DNSSEC: a name required to validate that comes back NOERROR-with-data but AD=0
    // over our trusted transport indicates stripping/downgrade — refuse it rather than serve unsigned.
    if (config.dnssec === 'strict' && !ad && resp.rcode === 'NOERROR' && answers.length) {
      const mustValidate = (config.dnssecStrictDomains || []).some(s => q.name === s || q.name.endsWith('.' + s));
      if (mustValidate) {
        stats.servfail++;
        return respond('SERVFAIL', [], `dnssec-strict:${q.name}`, edeOption(EDE.DNSSEC_BOGUS || 6, 'DNSSEC validation required'));
      }
    }
    cacheSet(key, resp.rcode, answers, minTtl(answers), ad);
    return respond(resp.rcode, answers, 'upstream', null, ad);
  } catch (e) {
    stats.upstreamFail++;
    if (hit && hit.stale) {                       // serve-stale saves the day
      stats.cacheStale++;
      return respond(hit.entry.rcode, buildAnswers(q, hit.entry), 'stale', edeOption(EDE.STALE, 'serve-stale: upstream unreachable'));
    }
    stats.servfail++;                             // honest SERVFAIL — and crucially, NOT cached
    return respond('SERVFAIL', [], `fail:${e.message}`);
  }
}

let ipv6State = { configured: false, listening: false, reason: 'not started' };

// ---------------------------------------------------------------- transports
const udp = dgram.createSocket('udp4');
udp.on('message', async (msg, rinfo) => {
  const out = await handleQuery(msg, { client: rinfo.address, proto: 'udp' });
  if (!out) return;
  if (out.length > config.dns.ednsUdpSize) {
    // truncate → client retries over TCP
    try {
      const dec = dnsPacket.decode(out);
      const tc = dnsPacket.encode({ ...dec, flags: (dec.flags || 0) | dnsPacket.TRUNCATED_RESPONSE, answers: [] });
      udp.send(tc, rinfo.port, rinfo.address);
    } catch { udp.send(out, rinfo.port, rinfo.address); }
  } else {
    udp.send(out, rinfo.port, rinfo.address);
  }
});
udp.on('error', e => { console.error('[udp]', e.message); });

let tcpServer = null;
if (config.dns.tcp) {
  tcpServer = net.createServer(sock => {
    let buf = Buffer.alloc(0);
    sock.on('data', async d => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2) {
        const len = buf.readUInt16BE(0);
        if (buf.length < 2 + len) break;
        const msg = buf.subarray(2, 2 + len);
        buf = buf.subarray(2 + len);
        stats.tcpQueries++;
        const out = await handleQuery(msg, { client: sock.remoteAddress?.replace('::ffff:', '') || '?', proto: 'tcp' });
        if (out) {
          const framed = Buffer.alloc(2 + out.length);
          framed.writeUInt16BE(out.length, 0); out.copy(framed, 2);
          sock.write(framed);
        }
      }
    });
    sock.on('error', () => {});
    sock.setTimeout(10000, () => sock.destroy());
  });
}

// ---------------------------------------------------------------- web UI + API
function authOk(req) {
  const t = req.headers['x-api-token'] || new URL(req.url, 'http://x').searchParams.get('token');
  if (t === config.web.apiToken) return true;
  return !!sessionUser(req);
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}
let _savingConfig = false, _reloadTimer = null;
function saveConfig(opts) {
  opts = opts || {};
  // Atomic: write a temp file then rename. fs.writeFileSync is NOT atomic — concurrent
  // workers writing the same path can interleave and corrupt config.json.
  const tmp = CONFIG_PATH + '.tmp.' + process.pid;
  const body = JSON.stringify(config, null, 2);
  try {
    // keep a last-known-good copy before overwriting
    if (fs.existsSync(CONFIG_PATH)) { try { fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + '.bak'); } catch {} }
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, CONFIG_PATH);
  } catch (e) {
    console.error('[config] save failed:', e.message);
    try { fs.unlinkSync(tmp); } catch {}
    return;
  }
  // Never broadcast while handling a reload — that is how the save/reload loop started.
  if (!opts.noBroadcast && !_savingConfig && global.__sdBroadcastReload) global.__sdBroadcastReload();
}

const webServer = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
  }
  // --- public auth endpoints (no token/session required) ---
  if (u.pathname === '/api/login' && req.method === 'POST') {
    const { username, password } = await readBody(req);
    if (verifyPw(password, users[username])) {
      const sid = newSession(username);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `sdsid=${sid}; HttpOnly; Path=/; Max-Age=${SESSION_MS/1000}; SameSite=Strict` });
      return res.end(JSON.stringify({ ok: true, user: username, role: users[username].role }));
    }
    return json(res, 401, { error: 'invalid credentials' });
  }
  if (u.pathname === '/api/logout' && req.method === 'POST') {
    const cookie = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('sdsid='));
    if (cookie) sessions.delete(cookie.slice(6));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'sdsid=; Path=/; Max-Age=0' });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (u.pathname === '/api/whoami' && req.method === 'GET') {
    const who = sessionUser(req);
    return json(res, 200, { user: who, authed: !!who || (req.headers['x-api-token'] === config.web.apiToken), tokenAuth: req.headers['x-api-token'] === config.web.apiToken });
  }
  if (!u.pathname.startsWith('/api/')) { res.writeHead(404); return res.end(); }
  if (!authOk(req)) return json(res, 401, { error: 'bad or missing token' });

  try {
    if (u.pathname === '/api/stats') {
      const all = await (global.__sdAggStats ? global.__sdAggStats() : Promise.resolve([{ ...stats, cacheSize: cache.size }]));
      const agg = all.reduce((a, s) => { for (const k of Object.keys(s)) { if (typeof s[k] === 'number') a[k] = (a[k] || 0) + s[k];
        else if (k === 'perCategory') { a.perCategory = a.perCategory || {}; for (const c of Object.keys(s[k])) a.perCategory[c] = (a.perCategory[c] || 0) + s[k][c]; } } return a; }, {});
      return json(res, 200, {
        stats: agg, workers: all.length, uptimeSec: Math.floor((Date.now() - startTime) / 1000),
        cacheSize: agg.cacheSize || cache.size, blocklist: blockMeta, ipv6: ipv6State,
        memory: { heapMB: Math.round(process.memoryUsage().heapUsed / 1048576),
                  rssMB: Math.round(process.memoryUsage().rss / 1048576),
                  budgetMB: config.cache.maxHeapMB || 512,
                  blockReasons: blockReasons.size, memEvictions: stats.memEvictions || 0 },
        upstreams: upstreams.map(x => ({ name: x.name, address: x.address, port: x.port, protocol: x.protocol, hostname: x.hostname, srtt: Math.round(x.srtt), timeout: Math.round(x.timeout()), circuitOpen: x.open, sent: x.sent, failed: x.failed })),
        categories: Object.fromEntries(Object.entries(config.categories).map(([k, v]) => [k, { enabled: v.enabled, target: v.target, target6: v.target6, domains: v.domains.length }])),
        config: {
          dns: config.dns, web: { port: config.web.port },
          race: config.race, ecs: config.ecs, dnsCookies: config.dnsCookies,
          caseRandomization: config.caseRandomization, failoverJitter: config.failoverJitter,
          rebindingProtection: config.rebindingProtection, dnssec: config.dnssec,
          dohCanaryNxdomain: config.dohCanaryNxdomain, qnameMinimization: config.qnameMinimization,
          happyEyeballs: config.happyEyeballs, filterAAAA: config.filterAAAA, workers: config.workers,
          blockedResponse: config.blockedResponse, blockPageIP: config.blockPageIP,
          clientAcl: config.clientAcl, rateLimitPerClientQps: config.rateLimitPerClientQps,
          internalZones: config.internalZones,
          cache: { serveStale: config.cache.serveStale, prefetch: config.cache.prefetch }
        }
      });
    }
    if (u.pathname === '/api/log') return json(res, 200, queryLogInOrder().slice(-Number(u.searchParams.get('n') || 200)));
    if (u.pathname === '/api/toggle' && req.method === 'POST') {
      const { category, enabled } = await readBody(req);
      if (!config.categories[category]) return json(res, 404, { error: 'no such category' });
      config.categories[category].enabled = !!enabled; saveConfig(); invalidateCategoryIndex();
      return json(res, 200, { category, enabled: config.categories[category].enabled });
    }
    if (u.pathname === '/api/category' && req.method === 'POST') {
      const { category, target, target6, domains } = await readBody(req);
      if (!category) return json(res, 400, { error: 'category required' });
      const c = config.categories[category] || (config.categories[category] = { enabled: true, target: '', target6: '', domains: [] });
      if (target !== undefined) c.target = target;
      if (target6 !== undefined) c.target6 = target6;
      if (Array.isArray(domains)) c.domains = domains.map(d => d.toLowerCase());
      saveConfig(); invalidateCategoryIndex();
      return json(res, 200, c);
    }
    if (u.pathname === '/api/category/delete' && req.method === 'POST') {
      const { category } = await readBody(req);
      if (!config.categories[category]) return json(res, 404, { error: 'no such category' });
      delete config.categories[category]; saveConfig(); invalidateCategoryIndex();
      return json(res, 200, { deleted: category });
    }
    if (u.pathname === '/api/category/rename' && req.method === 'POST') {
      const { from, to } = await readBody(req);
      if (!config.categories[from]) return json(res, 404, { error: 'no such category' });
      if (!to || config.categories[to]) return json(res, 400, { error: 'target name invalid or exists' });
      config.categories[to] = config.categories[from]; delete config.categories[from]; saveConfig(); invalidateCategoryIndex();
      return json(res, 200, { renamed: [from, to] });
    }
    if (u.pathname === '/api/category/move-domain' && req.method === 'POST') {
      const { domain, from, to } = await readBody(req);
      const d = String(domain || '').toLowerCase();
      if (from && config.categories[from]) config.categories[from].domains = config.categories[from].domains.filter(x => x !== d);
      if (to) {
        const c = config.categories[to] || (config.categories[to] = { enabled: true, target: config.defaultCacheTarget || '', target6: '', domains: [] });
        if (!c.domains.includes(d)) c.domains.push(d);
      }
      saveConfig(); invalidateCategoryIndex();
      return json(res, 200, { moved: d, from, to });
    }
    if (u.pathname === '/api/category/add-domain' && req.method === 'POST') {
      const { category, domain } = await readBody(req);
      const c = config.categories[category]; if (!c) return json(res, 404, { error: 'no such category' });
      const d = String(domain || '').toLowerCase();
      if (d && !c.domains.includes(d)) c.domains.push(d);
      saveConfig(); invalidateCategoryIndex(); return json(res, 200, c);
    }
    if (u.pathname === '/api/category/remove-domain' && req.method === 'POST') {
      const { category, domain } = await readBody(req);
      const c = config.categories[category]; if (!c) return json(res, 404, { error: 'no such category' });
      c.domains = c.domains.filter(x => x !== String(domain || '').toLowerCase());
      saveConfig(); return json(res, 200, c);
    }
    if (u.pathname === '/api/category/full' && req.method === 'GET') {
      return json(res, 200, config.categories);
    }
    if (u.pathname === '/api/flush' && req.method === 'POST') { const n = cache.size; cache.clear(); return json(res, 200, { flushed: n }); }
    if (u.pathname === '/api/blocklists' && req.method === 'GET') return json(res, 200, { lists: config.blocklists, meta: blockMeta });
    if (u.pathname === '/api/blocklists' && req.method === 'POST') {
      const { lists } = await readBody(req);
      if (Array.isArray(lists)) { config.blocklists = lists; saveConfig(); }
      const r = await refreshBlocklists();
      return json(res, 200, r);
    }
    if (u.pathname === '/api/blocklists/refresh' && req.method === 'POST') return json(res, 200, await refreshBlocklists());
    if (u.pathname === '/api/localrecords' && req.method === 'GET') return json(res, 200, config.localRecords || []);
    if (u.pathname === '/api/localrecords' && req.method === 'POST') {
      const { records } = await readBody(req);
      if (Array.isArray(records)) { config.localRecords = records; saveConfig(); invalidateLocalIndex(); }
      return json(res, 200, config.localRecords);
    }
    if (u.pathname === '/api/upstreams' && req.method === 'POST') {
      const { list } = await readBody(req);
      if (Array.isArray(list) && list.length) {
        config.upstreams = list; saveConfig();
        upstreams = config.upstreams.map(x => new Upstream(x));
      }
      return json(res, 200, config.upstreams);
    }
    if (u.pathname === '/api/import-uklans' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.defaultTarget) config.defaultCacheTarget = body.defaultTarget;
      const r = await importUklans();
      return json(res, 200, { imported: r, categories: Object.keys(config.categories).length });
    }
    if (u.pathname === '/api/subnetpolicies' && req.method === 'GET') return json(res, 200, config.subnetPolicies || []);
    if (u.pathname === '/api/subnetpolicies' && req.method === 'POST') {
      const { policies } = await readBody(req);
      if (Array.isArray(policies)) { config.subnetPolicies = policies; saveConfig(); }
      return json(res, 200, config.subnetPolicies || []);
    }
    if (u.pathname === '/api/passwd' && req.method === 'POST') {
      const { username, oldPassword, newPassword } = await readBody(req);
      const target = username || sessionUser(req);
      if (!target || !users[target]) return json(res, 404, { error: 'no such user' });
      // must know old password unless authed by master token
      if (req.headers['x-api-token'] !== config.web.apiToken && !verifyPw(oldPassword, users[target]))
        return json(res, 401, { error: 'old password wrong' });
      if (!newPassword || newPassword.length < 6) return json(res, 400, { error: 'password too short (min 6)' });
      users[target] = { ...hashPw(newPassword), role: users[target].role }; saveUsers(users);
      return json(res, 200, { ok: true, user: target });
    }
    if (u.pathname === '/api/users' && req.method === 'GET') {
      return json(res, 200, Object.entries(users).map(([n, r]) => ({ username: n, role: r.role })));
    }
    if (u.pathname === '/api/users/add' && req.method === 'POST') {
      const { username, password, role } = await readBody(req);
      if (!username || !password || password.length < 6) return json(res, 400, { error: 'need username + password(6+)' });
      if (users[username]) return json(res, 400, { error: 'user exists' });
      users[username] = { ...hashPw(password), role: role || 'user' }; saveUsers(users);
      return json(res, 200, { ok: true, user: username });
    }
    if (u.pathname === '/api/users/delete' && req.method === 'POST') {
      const { username } = await readBody(req);
      if (!users[username]) return json(res, 404, { error: 'no such user' });
      if (Object.keys(users).length === 1) return json(res, 400, { error: 'cannot delete last user' });
      delete users[username]; saveUsers(users);
      return json(res, 200, { ok: true, deleted: username });
    }
    if (u.pathname === '/api/forwarders' && req.method === 'GET') {
      return json(res, 200, {
        conditionalForwarders: config.conditionalForwarders || [],
        internalZones: config.internalZones || [],
        internalFallback: config.internalFallback,
        internalFallbackActive: internalFallbackUpstreams.map(u => `${u.address}:${u.port}`),
        reverseForwarders: config.reverseForwarders || [],
        detectedGateway: detectGateway()
      });
    }
    if (u.pathname === '/api/settings' && req.method === 'POST') {
      const b = await readBody(req);
      const allowTop = ['race','ecs','ecsPrefixV4','ecsPrefixV6','qnameMinimization','happyEyeballs','filterAAAA',
        'dnssec','rebindingProtection','rebindingAllow','dnsCookies','caseRandomization','failoverJitter',
        'dohCanaryNxdomain','blockedResponse','blockPageIP','clientAcl','rateLimitPerClientQps',
        'internalZones','workers'];
      for (const k of allowTop) if (k in b) config[k] = b[k];
      if (b.cache && typeof b.cache === 'object') config.cache = { ...config.cache, ...b.cache };
      saveConfig();
      if (global.__sdBroadcastReload) global.__sdBroadcastReload();
      return json(res, 200, { ok: true });
    }
    if (u.pathname === '/api/forwarders' && req.method === 'POST') {
      const b = await readBody(req);
      if (Array.isArray(b.conditionalForwarders)) config.conditionalForwarders = b.conditionalForwarders;
      if (Array.isArray(b.internalZones)) config.internalZones = b.internalZones;
      if ('internalFallback' in b) config.internalFallback = b.internalFallback;
      if (Array.isArray(b.reverseForwarders)) config.reverseForwarders = b.reverseForwarders;
      saveConfig(); buildCondForwarders(); buildInternalFallback();
      if (global.__sdBroadcastReload) global.__sdBroadcastReload();
      return json(res, 200, { conditionalForwarders: config.conditionalForwarders, internalZones: config.internalZones });
    }
    if (u.pathname === '/api/analytics') {
      const top = {}, clients = {}, blocked = {}, byDisp = {};
      for (const e of queryLogInOrder()) {
        top[e.name] = (top[e.name] || 0) + 1;
        clients[e.client] = (clients[e.client] || 0) + 1;
        const d = (e.disp || 'other').split(':')[0];
        byDisp[d] = (byDisp[d] || 0) + 1;
        if (d === 'blocked' || d === 'launcher-off' || d === 'rebind-blocked' || d === 'internal-nxdomain') blocked[e.name] = (blocked[e.name] || 0) + 1;
      }
      const rank = o => Object.entries(o).sort((a,b)=>b[1]-a[1]).slice(0,15).map(([k,v])=>({name:k,count:v}));
      return json(res, 200, { sample: queryLog.length, topDomains: rank(top), topClients: rank(clients), topBlocked: rank(blocked), byDisposition: byDisp });
    }
    if (u.pathname === '/api/gen/ad-domain' && req.method === 'POST') {
      const b = await readBody(req);
      const domain = String(b.domain || '').toLowerCase().replace(/^\.|\.$/g, '');
      const dcs = (Array.isArray(b.dcs) ? b.dcs : String(b.dcs || '').split(',')).map(s => String(s).trim()).filter(Boolean);
      if (!domain || !dcs.length) return json(res, 400, { error: 'need domain and at least one DC address' });
      const upstreams = dcs.map((a, i) => ({ name: `dc${i + 1}`, address: a, port: 53 }));
      // forward the AD domain (covers _msdcs.<domain> and all SRV records beneath it)
      config.conditionalForwarders = (config.conditionalForwarders || []).filter(c => String(c.zone).toLowerCase() !== domain);
      config.conditionalForwarders.push({ zone: domain, upstreams });
      // make sure the TLD is treated as internal so it never leaks
      const tld = domain.split('.').pop();
      config.internalZones = Array.from(new Set([...(config.internalZones || []), tld]));
      // private reverse lookups should also go to the DC (AD relies on PTR)
      if (b.useForReverse !== false) config.reverseForwarders = upstreams;
      saveConfig(); buildCondForwarders(); buildInternalFallback(); invalidateLocalIndex();
      if (global.__sdBroadcastReload) global.__sdBroadcastReload();
      setTimeout(() => { try { probeInternalResolvers(); } catch {} }, 300);
      return json(res, 200, { ok: true, domain, dcs, internalZones: config.internalZones,
        note: `All of *.${domain} (including _msdcs and SRV records) now goes to ${dcs.join(', ')}. Private PTR lookups too.` });
    }
    if (u.pathname === '/api/gen/apt-cacher' && req.method === 'POST') {
      const { zone, proxyHost, proxyIP, port } = await readBody(req);
      const z = (zone || 'lan').replace(/^\.|\.$/g, '');
      const p = Number(port) || 3142;
      // If given an IP, use it directly as the SRV target when no hostname was supplied,
      // and always emit the matching A record so the SRV actually resolves.
      const host = proxyHost || (proxyIP ? `aptcache.${z}` : `aptcache.${z}`);
      const recs = [
        { name: `_apt_proxy._tcp.${z}`, type: 'SRV', data: { priority: 0, weight: 0, port: p, target: host }, ttl: 3600 }
      ];
      let hint;
      if (proxyIP && /^\d+\.\d+\.\d+\.\d+$/.test(String(proxyIP).trim())) {
        recs.push({ name: host, type: 'A', data: String(proxyIP).trim(), ttl: 3600 });
        hint = `Clients running auto-apt-proxy will find ${host}:${p} (${proxyIP}). Both the SRV and its A record were generated — click Save records.`;
      } else {
        hint = `SRV points at ${host}:${p}. You still need an A record for ${host} — re-run with the proxy IP filled in, or add it manually.`;
      }
      return json(res, 200, { records: recs, hint });
    }
    if (u.pathname === '/api/gen/apple-cache' && req.method === 'POST') {
      const { zone, publicRanges, localRanges } = await readBody(req);
      const z = (zone || 'lan').replace(/^\.|\.$/g, '');
      const parts = [];
      if (publicRanges) parts.push(`prs=${publicRanges}`);
      if (localRanges) parts.push(`fss=${localRanges}`);
      const txt = parts.join(' ') || 'prs=';
      const recs = [ { name: `_aaplcache._tcp.${z}`, type: 'TXT', data: txt, ttl: 10800 } ];
      return json(res, 200, { records: recs, hint: `Publishes Apple Content Caching discovery for zone ${z}. prs = your public IP range(s); fss = your caching servers' local IP range so devices prefer them.` });
    }
    if (u.pathname === '/api/metrics') {
      const lines = [];
      const g = (n, v, help) => { lines.push(`# HELP stellardns_${n} ${help}`); lines.push(`# TYPE stellardns_${n} gauge`); lines.push(`stellardns_${n} ${v}`); };
      g('queries_total', stats.queries, 'Total DNS queries');
      g('cache_hits_total', stats.cacheHits, 'Cache hits');
      g('cache_stale_total', stats.cacheStale, 'Stale answers served');
      g('rewrites_total', stats.rewrites, 'LANCache rewrites');
      g('blocked_total', stats.blocked, 'Blocked queries');
      g('servfail_total', stats.servfail, 'SERVFAIL responses');
      g('coalesced_total', stats.coalesced, 'Coalesced duplicate queries');
      g('cache_entries', cache.size, 'Current cache entries');
      g('blocklist_entries', blockSet.size, 'Active blocklist entries');
      g('dot_queries_total', stats.dotQueries || 0, 'DNS-over-TLS queries');
      g('doh_queries_total', stats.dohQueries || 0, 'DNS-over-HTTPS queries');
      for (const up of upstreams) {
        lines.push(`stellardns_upstream_srtt_ms{upstream="${up.name}"} ${Math.round(up.srtt)}`);
        lines.push(`stellardns_upstream_circuit_open{upstream="${up.name}"} ${up.open ? 1 : 0}`);
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      return res.end(lines.join('\n') + '\n');
    }
    return json(res, 404, { error: 'unknown endpoint' });
  } catch (e) { return json(res, 500, { error: e.message }); }
});

// ---------------------------------------------------------------- boot (cluster-aware)
const WORKER_COUNT = (() => {
  const w = Number(config.workers);
  if (w === 1) return 1;
  const n = w > 0 ? w : Math.min(os.cpus().length, 8);
  return Math.max(1, n);
})();

// one-time setup done ONCE in the primary before any worker forks (avoids races on users.json / cert)
if (cluster.isPrimary) { ensureAdmin(); ensureCert(); try { registerSelfRecord(); } catch (e) { console.error('[self]', e.message); } }

if (cluster.isPrimary && WORKER_COUNT > 1) {
  console.log(`[cluster] master starting ${WORKER_COUNT} workers across ${os.cpus().length} cores`);
  const workers = [];
  const pendingStats = new Map(); // reqId -> {replies, expect, resolveTo}
  for (let i = 0; i < WORKER_COUNT; i++) {
    const w = cluster.fork({ SD_PRIMARY: i === 0 ? '1' : '0' });
    workers.push(w);
  }
  cluster.on('message', (fromWorker, msg) => {
    if (msg.t === 'reload') {                      // a worker changed config -> everyone rereads
      for (const w of Object.values(cluster.workers)) w.send({ t: 'reload' });
    } else if (msg.t === 'statsReq') {             // primary wants sibling stats
      const req = { replies: [], expect: Object.keys(cluster.workers).length, from: fromWorker.id, reqId: msg.reqId };
      pendingStats.set(msg.reqId, req);
      for (const w of Object.values(cluster.workers)) w.send({ t: 'statsGet', reqId: msg.reqId });
      setTimeout(() => {                           // reply with whatever arrived
        const r = pendingStats.get(msg.reqId);
        if (r) { pendingStats.delete(msg.reqId);
          const target = Object.values(cluster.workers).find(w => w.id === r.from);
          if (target) target.send({ t: 'statsAgg', reqId: msg.reqId, all: r.replies }); }
      }, 250);
    } else if (msg.t === 'statsPart') {
      const r = pendingStats.get(msg.reqId);
      if (r) r.replies.push(msg.stats);
    }
  });
  cluster.on('exit', (w, code) => {
    console.error(`[cluster] worker ${w.id} died (${code}) - respawning`);
    cluster.fork({ SD_PRIMARY: w.id === 1 ? '1' : '0' });
  });
} else {
  const IS_PRIMARY = WORKER_COUNT === 1 || process.env.SD_PRIMARY === '1';

  // IPC handlers (only in cluster mode)
  const statsWaiters = new Map();
  if (WORKER_COUNT > 1) {
    process.on('message', msg => {
      if (msg.t === 'reload') {
        // Debounce: a burst of saves must not cause a burst of full reloads.
        clearTimeout(_reloadTimer);
        _reloadTimer = setTimeout(() => {
          try {
            const fresh = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
            const prevBl = JSON.stringify(config.blocklists || []);
            _savingConfig = true;   // suppress rebroadcast while applying a reload
            config = deepMerge(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), fresh);
            users = loadUsers();
            upstreams = config.upstreams.map(u => new Upstream(u));
            buildCondForwarders(); buildInternalFallback();
            _savingConfig = false;
            // Only re-parse the blocklist snapshot if the blocklist config changed.
            // It used to run on EVERY config save, in EVERY worker — a multi-hundred-
            // thousand entry JSON.parse per worker per rule save.
            if (JSON.stringify(config.blocklists || []) !== prevBl) loadBlocklistFromDisk();
          } catch (e) { console.error('[reload]', e.message); }
        }, 250);
      } else if (msg.t === 'statsGet') {
        process.send({ t: 'statsPart', reqId: msg.reqId, stats: { ...stats, cacheSize: cache.size } });
      } else if (msg.t === 'statsAgg') {
        const w = statsWaiters.get(msg.reqId);
        if (w) { statsWaiters.delete(msg.reqId); w(msg.all); }
      }
    });
  }
  global.__sdBroadcastReload = () => { if (WORKER_COUNT > 1) try { process.send({ t: 'reload' }); } catch {} };
  global.__sdAggStats = () => new Promise(resolve => {
    if (WORKER_COUNT === 1) return resolve([{ ...stats, cacheSize: cache.size }]);
    const reqId = crypto.randomBytes(6).toString('hex');
    statsWaiters.set(reqId, resolve);
    try { process.send({ t: 'statsReq', reqId }); } catch { resolve([{ ...stats, cacheSize: cache.size }]); }
    setTimeout(() => { if (statsWaiters.has(reqId)) { statsWaiters.delete(reqId); resolve([{ ...stats, cacheSize: cache.size }]); } }, 400);
  });

  applyMemoryBudget();
  buildCondForwarders();
  buildInternalFallback();
  setTimeout(() => { try { probeInternalResolvers(); } catch {} }, 1500);
  loadBlocklistFromDisk();
  restoreCache();
  if (IS_PRIMARY) {
    refreshBlocklists().catch(() => {});
    setInterval(() => refreshBlocklists().catch(() => {}), Math.max(1, config.blocklistRefreshHours) * 3600 * 1000);
    setInterval(snapshotCache, config.cache.snapshotIntervalSec * 1000);
  }
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { flushFileLog(); } catch {} if (IS_PRIMARY) snapshotCache(); process.exit(0); });

  udp.bind(config.dns.port, config.dns.host, () => console.log(`[dns] UDP listening on ${config.dns.host}:${config.dns.port} (worker ${cluster.worker ? cluster.worker.id : 0})`));
  ipv6State.configured = !!config.dns.host6;
  if (config.dns.host6) {   // '::' = dual-stack listener; false/null disables
    const udp6 = dgram.createSocket({ type: 'udp6', ipv6Only: true, reuseAddr: true });
    udp6.on('message', async (msg, rinfo) => {
      const out = await handleQuery(msg, { client: rinfo.address, proto: 'udp6' });
      if (out) udp6.send(out, rinfo.port, rinfo.address);
    });
    udp6.on('error', e => {
      ipv6State.listening = false;
      if (e.code === 'EAFNOSUPPORT' || e.code === 'EADDRNOTAVAIL') {
        ipv6State.reason = 'no IPv6 on this host';
        console.warn('[dns] IPv6 not available on this host — v6 listener disabled');
      } else { ipv6State.reason = e.message; console.error('[udp6]', e.message); }
    });
    udp6.bind(config.dns.port, config.dns.host6, () => {
      ipv6State.listening = true; ipv6State.reason = 'ok';
      console.log(`[dns] UDP6 listening on [${config.dns.host6}]:${config.dns.port}`);
    });
  }
  if (tcpServer && IS_PRIMARY) {
    // '::' with ipv6Only unset is dual-stack on Linux: serves both v4 and v6 clients.
    const tcpHost = (config.dns.host === '0.0.0.0' && config.dns.host6) ? '::' : config.dns.host;
    tcpServer.on('error', e => {
      if (tcpHost === '::') { console.warn('[dns] TCP dual-stack bind failed, falling back to IPv4'); try { tcpServer.listen(config.dns.port, config.dns.host); } catch {} }
      else console.error('[dns/tcp]', e.message);
    });
    tcpServer.listen(config.dns.port, tcpHost, () => console.log(`[dns] TCP listening on ${tcpHost}:${config.dns.port}`));
  }
  if (IS_PRIMARY) { startDot(); startDoh(); }
  if (IS_PRIMARY) {
    startBlockPage();
    const webHost = (config.web.host === '0.0.0.0' && config.dns.host6) ? '::' : config.web.host;
webServer.on('error', e => { if (webHost === '::') { try { webServer.listen(config.web.port, config.web.host); } catch {} } });
webServer.listen(config.web.port, webHost, () =>
      console.log(`[web] UI on http://${config.web.host}:${config.web.port}  (token: ${config.web.apiToken})`));
  }
}
