'use strict';
/* Client configuration.
 * Deliberately a plain JSON file in the OS's per-machine config location, because the
 * service, the GUI and the CLI all have to agree on it and none of them should need a
 * database to read a blocklist URL.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let _baseDir = null;
function baseDir() {
  if (process.env.STELLARDNS_CLIENT_HOME) return process.env.STELLARDNS_CLIENT_HOME;
  if (_baseDir) return _baseDir;
  const candidates = [];
  if (process.platform === 'win32') {
    // ProgramData is the right home for a service, but it is not always creatable by a
    // standard user. Fall back to the user's local app data rather than failing to start.
    if (process.env.PROGRAMDATA) candidates.push(path.join(process.env.PROGRAMDATA, 'StellarDNS'));
    if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'StellarDNS'));
  } else if (process.platform === 'darwin') {
    candidates.push(path.join(os.homedir(), 'Library', 'Application Support', 'StellarDNS'));
  } else {
    candidates.push(path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'stellardns-client'));
  }
  for (const dir of candidates) {
    try { fs.mkdirSync(dir, { recursive: true }); _baseDir = dir; return dir; } catch {}
  }
  _baseDir = candidates[candidates.length - 1];
  return _baseDir;
}

const CONFIG_PATH = path.join(baseDir(), 'client.json');
const DATA_DIR = path.join(baseDir(), 'data');

const DEFAULTS = {
  version: 1,
  listen: { host: '127.0.0.1', port: 53 },
  // DoH first: it survives restrictive networks that drop port 853. DoT is the fallback
  // for networks that filter hostile-looking HTTPS paths.
  upstreams: [
    { name: 'cloudflare', protocol: 'https', hostname: 'cloudflare-dns.com', path: '/dns-query' },
    { name: 'quad9', protocol: 'https', hostname: 'dns.quad9.net', path: '/dns-query' },
    { name: 'quad9-dot', protocol: 'tls', hostname: 'dns.quad9.net', port: 853 }
  ],
  blocklists: [
    { name: 'oisd-small', url: 'https://small.oisd.nl/', enabled: true }
  ],
  allowlist: [],
  // Rewrites imported from a StellarDNS server: category -> { enabled, target, target6, domains }.
  categories: {},
  // Imported rewrites are stored but inert until this is true. Pointing a launcher's names at
  // a cache that is not reachable breaks downloads and, for some titles, the game itself —
  // so saving a rule and applying it are deliberately two different decisions.
  rewritesEnabled: false,
  importedFrom: null,             // { server, version, at, categories, lists } once imported
  blockResponse: 'nxdomain',      // 'nxdomain' | 'zeroip'
  blockingEnabled: true,
  cacheMaxEntries: 20000,
  ttlMin: 30,
  ttlMax: 3600,
  gui: { host: '127.0.0.1', port: 5381 },
  // Off by default: repointing a machine's resolver is a visible, network-breaking change.
  // The GUI asks on first run and `set-dns` asks explicitly; neither applies silently.
  setSystemDns: false,
  // Cleared only once the user answers the first-run DNS prompt, so it is asked exactly once
  // per install rather than every launch.
  dnsPromptShown: false,
  blocklistRefreshHours: 24,
  systemDnsBackup: null
};

function deepMerge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return override === undefined ? base : override;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(override)) {
    out[k] = deepMerge(out[k], override[k]);
  }
  return out;
}

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let onDisk = {};
  try { onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') console.error('[config] unreadable, using defaults:', e.message);
  }
  return deepMerge(DEFAULTS, onDisk);
}

function save(cfg) {
  fs.mkdirSync(baseDir(), { recursive: true });
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);      // atomic: a crash never leaves half a config
  return CONFIG_PATH;
}

module.exports = { load, save, baseDir, DATA_DIR, CONFIG_PATH, DEFAULTS };
