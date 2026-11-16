'use strict';
/* Blocklist parsing and suffix matching.
 * The matching question is "is this name, or any parent of it, on the list" — a block on
 * example.com must also catch ads.example.com. Walking the labels of the query is O(labels)
 * and needs no trie for the tens of thousands of entries a client carries.
 */
const fs = require('fs');
const https = require('https');
const path = require('path');

const HOSTS_IP = /^(0\.0\.0\.0|127\.0\.0\.1|::1?|::ffff:0:0|255\.255\.255\.255)$/;

function normalise(raw) {
  let d = String(raw || '').trim().toLowerCase();
  if (!d || d.startsWith('#') || d.startsWith('!')) return null;
  // Adblock syntax: ||domain^$third-party
  if (d.startsWith('||')) {
    d = d.slice(2).split('^')[0].split('$')[0];
  }
  // Hosts lines: "0.0.0.0 domain" or "127.0.0.1 domain"
  if (/\s/.test(d)) {
    const parts = d.split(/\s+/);
    if (HOSTS_IP.test(parts[0])) d = parts[1] || '';
    else d = parts[0];
  }
  d = d.replace(/^\*\./, '').replace(/\.$/, '');
  if (!d || d === 'localhost' || !d.includes('.')) return null;
  if (!/^[a-z0-9._-]+$/.test(d)) return null;   // rejects url-ish junk and comments
  return d;
}

class Blocklist {
  constructor() {
    this.set = new Set();
    this.allow = new Set();
    this.meta = { entries: 0, sources: [], updatedAt: 0 };
  }

  add(domain) {
    const d = normalise(domain);
    if (d && !this.set.has(d)) { this.set.add(d); return true; }
    return false;
  }

  loadText(text, source) {
    let added = 0;
    for (const line of String(text).split(/\r?\n/)) if (this.add(line)) added++;
    if (source) this.meta.sources.push({ source, added });
    return added;
  }

  setAllowlist(list) {
    this.allow = new Set((list || []).map(normalise).filter(Boolean));
  }

  // Walk the name's suffixes: ads.example.com -> ads.example.com, example.com, com.
  match(name) {
    const n = String(name || '').toLowerCase().replace(/\.$/, '');
    if (!n) return null;
    let i = 0;
    while (i < n.length) {
      const candidate = n.slice(i);
      if (this.set.has(candidate)) {
        for (let j = 0; j <= i; j = n.indexOf('.', j) + 1) {
          if (j < 0) break;
          if (this.allow.has(n.slice(j))) return null;   // allowlist wins for the whole subtree
        }
        return candidate;
      }
      const dot = n.indexOf('.', i);
      if (dot === -1) break;
      i = dot + 1;
    }
    return null;
  }

  get size() { return this.set.size; }
}

function fetchText(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'https:') return reject(new Error('blocklists must be https'));
    const req = https.get(u, { timeout: timeoutMs, headers: { 'user-agent': 'stellardns-client/26' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchText(new URL(res.headers.location, u).toString(), timeoutMs));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout fetching ' + u.hostname)));
    req.on('error', reject);
  });
}

async function build(cfg, dataDir, log = () => {}) {
  const list = new Blocklist();
  list.setAllowlist(cfg.allowlist);
  const cacheDir = path.join(dataDir, 'blocklists');
  fs.mkdirSync(cacheDir, { recursive: true });
  for (const source of cfg.blocklists || []) {
    if (!source.enabled) continue;
    const cacheFile = path.join(cacheDir, source.name.replace(/[^a-z0-9._-]/gi, '_') + '.txt');
    let text = null;
    try {
      text = await fetchText(source.url);
      fs.writeFileSync(cacheFile, text);
      log('refresh', `${source.name}: ${text.length} bytes fetched`);
    } catch (e) {
      // A stale list is better than no list: keep filtering while the network is down.
      try { text = fs.readFileSync(cacheFile, 'utf8'); log('warn', `${source.name}: ${e.message}, using cached copy`); }
      catch { log('warn', `${source.name}: ${e.message}, and no cached copy`); continue; }
    }
    const added = list.loadText(text, source.name);
    log('load', `${source.name}: ${added} domains`);
  }
  // Local entries come last so a hand-added block survives every list refresh.
  const localFile = path.join(dataDir, 'local-block.txt');
  if (fs.existsSync(localFile)) {
    const added = list.loadText(fs.readFileSync(localFile, 'utf8'), 'local');
    log('load', `local: ${added} domains`);
  }
  list.meta.entries = list.size;
  list.meta.updatedAt = Date.now();
  return list;
}

module.exports = { Blocklist, build, normalise, fetchText };
