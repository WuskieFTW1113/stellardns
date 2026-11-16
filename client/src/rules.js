'use strict';
/* Pulling policy from a server, and keeping only what the user picked.
 * The server never pushes: the client asks for the whole ruleset, shows what is in it, and
 * writes the selection into its own config. Nothing here trusts the bundle beyond its shape.
 */
const http = require('http');
const https = require('https');

function requestJson(target, token, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(target); } catch { return reject(new Error('invalid server address')); }
    if (!['http:', 'https:'].includes(u.protocol)) return reject(new Error('http or https only'));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      host: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      timeout: timeoutMs,
      headers: { accept: 'application/json', ...(token ? { 'x-api-token': token } : {}) }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode === 401) {
          return reject(Object.assign(new Error('server rejected the token'), { statusCode: 401 }));
        }
        if (res.statusCode === 403) {
          return reject(Object.assign(new Error('that token is not allowed to read rules'), { statusCode: 403 }));
        }
        if (res.statusCode !== 200) {
          return reject(Object.assign(new Error('server returned HTTP ' + res.statusCode), { statusCode: res.statusCode }));
        }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('server did not return JSON')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out talking to the server')));
    req.on('error', reject);
    req.end();
  });
}

function baseUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('server address required');
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  let u;
  try { u = new URL(s); } catch { throw new Error('invalid server address'); }
  return u.origin;
}

/* Rules import arrived in v25. Compared on the major number only, and an unparseable version is
 * treated as too old rather than optimistically as current. */
function supportsRules(version) {
  const major = parseInt(String(version).split('.')[0], 10);
  return Number.isFinite(major) && major >= 25;
}

async function fetchRules(server, token) {
  const base = baseUrl(server);
  let bundle;
  try {
    bundle = await requestJson(base + '/api/client/rules', token);
  } catch (e) {
    /* A v24 server has no rules route, and its auth gate answers 401 to any path it does not
     * know — so even a correct token cannot get through, and 404 only appears once a token is
     * accepted. Either way the version endpoint, which is unauthenticated on both releases, says
     * what is really wrong. Blaming the token here sends people off to fix the wrong thing. */
    const info = await fetchVersion(base);
    if (info && !supportsRules(info.version)) {
      throw new Error(`${base} is StellarDNS ${info.version || 'older than v25'}; rules import needs v25 or newer on the server`);
    }
    if (e.statusCode === 404) {
      throw new Error(info
        ? `${base} is StellarDNS ${info.version}, but its rules route did not answer (HTTP 404)`
        : `${base} answered, but not as a StellarDNS server (HTTP 404)`);
    }
    throw e;
  }
  if (!bundle || bundle.service !== 'stellardns') throw new Error('that address is not a StellarDNS server');
  return { ...bundle, server: base };
}

/* Unauthenticated on both releases, so it is safe to ask before we own a token, and it is the
 * only reliable way to tell 'not a StellarDNS box' from 'a StellarDNS box too old to help'.
 * Never throws: it is a diagnosis, and a failure to diagnose is not the user's problem. */
function fetchVersion(base, timeoutMs = 4000) {
  return requestJson(base + '/api/version', '', timeoutMs)
    .then(j => (j && j.name === 'stellardns'
      ? { name: j.name, version: String(j.version || ''), codename: j.codename || '' }
      : null))
    .catch(() => null);
}

/* selection: { categories: [names], blocklists: [urls], allowlist: bool } */
function selectRules(bundle, selection = {}) {
  const categories = {};
  for (const name of selection.categories || []) {
    if (bundle.categories && bundle.categories[name]) categories[name] = bundle.categories[name];
  }
  const wanted = new Set(selection.blocklists || []);
  const blocklists = (bundle.blocklists || []).filter(l => wanted.has(l.url));
  const allowlist = selection.allowlist ? (bundle.allowlist || []) : [];
  return { categories, blocklists, allowlist };
}

function applyRules(cfg, picked, bundle) {
  cfg.categories = picked.categories;
  cfg.blocklists = picked.blocklists;
  if (picked.allowlist.length) {
    cfg.allowlist = Array.from(new Set([...(cfg.allowlist || []), ...picked.allowlist]));
  }
  cfg.importedFrom = {
    server: bundle.server || '',
    version: bundle.version || '',
    at: Date.now(),
    categories: Object.keys(picked.categories),
    lists: picked.blocklists.length,
    allowlist: picked.allowlist.length
  };
  return cfg;
}

module.exports = { fetchRules, fetchVersion, supportsRules, selectRules, applyRules, baseUrl, requestJson };
