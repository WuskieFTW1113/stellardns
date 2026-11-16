#!/usr/bin/env node
'use strict';
/* stellardns-client — Linux (AppImage + CLI), Windows and macOS share this core.
 *
 *   stellardns-client run              start the resolver and the GUI
 *   stellardns-client run --port 5353  start on a high port (no root needed)
 *   stellardns-client status           one screen of truth
 *   stellardns-client test <name> [A]  resolve through the encrypted upstream
 *   stellardns-client block <domain>   add a local block
 *   stellardns-client unblock <domain> allowlist it
 *   stellardns-client refresh          re-download blocklists now
 *   stellardns-client import <server>  copy rules from a StellarDNS server (--all, --token)
 *   stellardns-client rewrites on|off  apply imported rewrites, or stop applying them
 *   stellardns-client set-dns          point the OS at 127.0.0.1
 *   stellardns-client restore-dns      put the previous DNS back
 *   stellardns-client install-service  systemd user unit (Linux); prints the Windows/macOS equivalent
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { load, save, CONFIG_PATH, DATA_DIR } = require('./config');
const { Blocklist, build } = require('./blocklist');
const { Resolver, startListeners } = require('./proxy');
const sysdns = require('./sysdns');
const rules = require('./rules');

const VERSION = require('../package.json').version;
const log = (tag, msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${String(tag).padEnd(9)} ${msg}`);

function parseFlags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      out[k] = v !== undefined ? v : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
    } else out._.push(a);
  }
  return out;
}

async function makeResolver(cfg, quiet) {
  const list = await build(cfg, DATA_DIR, (t, m) => { if (!quiet) log(t, m); });
  return new Resolver(cfg, list);
}

async function cmdRun(cfg, flags) {
  if (flags.port) cfg.listen.port = Number(flags.port);
  const resolver = await makeResolver(cfg);
  delete cfg.listen.blockedPort;
  delete cfg.listen.blockedBy;
  let listeners;
  try {
    listeners = await startListeners(resolver, cfg, log);
  } catch (e) {
    // Port 53 is often taken (ICS, another resolver) or forbidden to a standard user on
    // Unix. Try a few alternatives rather than refusing to start. 5353 is last: mDNS already
    // owns it on Windows, so picking it first failed on the very machine this targets.
    if (e.code === 'EACCES' || e.code === 'EADDRINUSE') {
      const wanted = Number(cfg.listen.port);
      const bound = [5300, 5301, 5354, 5353].find(p => p !== wanted);
      let chosen = null;
      for (const alt of [5300, 5301, 5354, 5353].filter(p => p !== wanted)) {
        try {
          cfg.listen.port = alt;
          listeners = await startListeners(resolver, cfg, log);
          chosen = alt;
          break;
        } catch { /* next candidate */ }
      }
      if (!chosen) throw e;
      // Name the program holding 53. "Port busy" with no owner is a dead end for a user who
      // cannot run netstat, and on Windows it is usually Internet Connection Sharing.
      let owner = null;
      try { owner = sysdns.portOwner ? sysdns.portOwner(wanted) : null; } catch {}
      cfg.listen.blockedPort = wanted;
      cfg.listen.blockedBy = owner ? `${owner.name || 'an unknown process'} (PID ${owner.pid})` : '';
      log('warn', `port ${wanted} unavailable (${e.code})` +
        (owner ? ` - held by ${owner.name || 'PID ' + owner.pid}` : '') +
        ` - listening on ${chosen}; DNS takeover stays off until the client can use 53`);
    } else throw e;
  }
  const gui = require('./gui');
  const server = await gui.start(resolver, cfg, {
    save,
    // An import or a settings change must take effect without a restart: rebuild the rewrite
    // index immediately, then refresh the lists in the background.
    reload: async () => {
      resolver.reload(cfg);
      try { resolver.blocklist = await build(cfg, DATA_DIR, log); }
      catch (e) { log('warn', 'blocklist reload failed: ' + e.message); }
    }
  });
  log('gui', `${server.url} — open this in a browser, or let the native shell load it`);

  // Only when no restore point exists. Re-applying on every start would overwrite the saved
  // original with 127.0.0.1 and destroy the only record of what to put back.
  if (cfg.setSystemDns !== false && !cfg.systemDnsBackup && !flags['no-dns'] && cfg.listen.port === 53) {
    try {
      const backup = sysdns.apply(cfg);
      cfg.systemDnsBackup = backup;
      save(cfg);
      log('dns', 'system resolver pointed at 127.0.0.1 (backup saved)');
    } catch (e) {
      log('warn', 'could not set system DNS: ' + e.message + ' — run as root, or set it manually');
    }
  }

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    log('stop', 'shutting down');
    try { if (cfg.systemDnsBackup) sysdns.restore(cfg.systemDnsBackup); } catch (e) { log('warn', 'DNS restore failed: ' + e.message); }
    try { listeners.close(); } catch {}
    try { server.close(); } catch {}
    setTimeout(() => process.exit(0), 200);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  // A shell that is killed rather than closed leaves this process holding :5381 and :53, so
  // the next launch cannot bind while the stale core keeps serving the old code. The Windows
  // shell passes its own pid; when it is gone, so is this process.
  if (flags['parent-pid']) {
    const parent = Number(flags['parent-pid']);
    if (Number.isFinite(parent) && parent > 0) {
      const watch = setInterval(() => {
        try { process.kill(parent, 0); }
        catch { clearInterval(watch); log('stop', 'the shell that started this core is gone'); stop(); }
      }, 2000);
      if (watch.unref) watch.unref();
    }
  }

  log('ready', `v${VERSION} — ${resolver.upstreams.length} encrypted upstreams, ${resolver.blocklist.size} blocked domains`);
}

async function cmdStatus(cfg) {
  let live = null;
  try {
    const res = await fetch(`http://${(cfg.gui && cfg.gui.host) || '127.0.0.1'}:${(cfg.gui && cfg.gui.port) || 5381}/api/state`);
    if (res.ok) live = await res.json();
  } catch {}
  console.log(`StellarDNS client v${VERSION}`);
  console.log(`  config      ${CONFIG_PATH}`);
  console.log(`  listen      ${cfg.listen.host}:${cfg.listen.port}`);
  console.log(`  upstreams   ${(cfg.upstreams || []).map(u => `${u.name}(${u.protocol || 'https'})`).join(', ')}`);
  console.log(`  blocklists  ${(cfg.blocklists || []).filter(b => b.enabled).length} enabled`);
  console.log(`  system DNS  ${cfg.setSystemDns === false ? 'not managed' : 'managed by this client'}`);
  if (live) {
    const s = live.stats || {};
    console.log(`  running     yes — ${s.queries || 0} queries, ${s.cacheHits || 0} cache hits, ${s.blocked || 0} blocked, ${s.failed || 0} failed`);
    console.log(`  blocked     ${(live.blocklist && live.blocklist.entries) || 0} domains loaded`);
  } else {
    console.log('  running     no (GUI not reachable — start it with: stellardns-client run)');
  }
}

async function cmdTest(cfg, name, type = 'A') {
  if (!name) { console.error('usage: stellardns-client test <name> [type]'); process.exit(2); }
  const dnsPacket = require('dns-packet');
  const list = new Blocklist();          // filtering is not the point of a transport test
  const resolver = new Resolver(cfg, list);
  const q = dnsPacket.encode({ type: 'query', id: Math.floor(Math.random() * 65535), flags: dnsPacket.RECURSION_DESIRED, questions: [{ type: type.toUpperCase(), name }] });
  const t0 = Date.now();
  const out = await resolver.handle(q);
  const ms = Date.now() - t0;
  if (!out) { console.error(`  FAIL  no answer (${resolver.stats.lastError || 'upstream error'})`); process.exit(1); }
  const r = dnsPacket.decode(out);
  console.log(`  ${name} ${type.toUpperCase()} — ${r.rcode} in ${ms}ms via ${resolver.stats.lastUpstream}`);
  for (const a of r.answers || []) console.log(`    ${a.name}  ${a.ttl}s  ${a.type}  ${typeof a.data === 'object' ? JSON.stringify(a.data) : a.data}`);
}

function cmdBlock(domain, cfg) {
  if (!domain) { console.error('usage: stellardns-client block <domain>'); process.exit(2); }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const f = path.join(DATA_DIR, 'local-block.txt');
  const d = String(domain).toLowerCase().trim();
  const cur = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  if (cur.split(/\r?\n/).includes(d)) return console.log(`  already blocked: ${d}`);
  fs.writeFileSync(f, cur.replace(/\s*$/, '\n') + d + '\n');
  console.log(`  blocked ${d} (restart the client to apply)`);
}

function cmdUnblock(domain, cfg) {
  if (!domain) { console.error('usage: stellardns-client unblock <domain>'); process.exit(2); }
  const d = String(domain).toLowerCase().trim();
  const f = path.join(DATA_DIR, 'local-block.txt');
  if (fs.existsSync(f)) fs.writeFileSync(f, fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(l => l.trim() && l.trim() !== d).join('\n') + '\n');
  cfg.allowlist = Array.from(new Set([...(cfg.allowlist || []), d]));
  save(cfg);
  console.log(`  allowlisted ${d} (restart the client to apply)`);
}

async function cmdImport(cfg, flags) {
  const url = flags._[0];
  if (!url) {
    console.error('usage: stellardns-client import <server> --token <token> [--all] [--categories a,b] [--lists] [--allowlist]');
    process.exit(2);
  }
  const bundle = await rules.fetchRules(url, flags.token || '');
  const all = !!flags.all;
  const selection = {
    categories: all ? Object.keys(bundle.categories || {}) : String(flags.categories || '').split(',').map(s => s.trim()).filter(Boolean),
    blocklists: all || flags.lists ? (bundle.blocklists || []).map(l => l.url) : [],
    allowlist: all || !!flags.allowlist
  };
  const picked = rules.selectRules(bundle, selection);
  rules.applyRules(cfg, picked, bundle);
  // Importing never turns rewrites on by itself. `--rewrites` is the explicit opt-in.
  cfg.rewritesEnabled = !!flags.rewrites;
  save(cfg);
  console.log(`  server      ${bundle.server} (v${bundle.version})`);
  console.log(`  categories  ${Object.keys(picked.categories).join(', ') || 'none'}`);
  console.log(`  blocklists  ${picked.blocklists.length}`);
  console.log(`  allowlist   ${picked.allowlist.length} entries`);
  console.log(`  rewrites    ${cfg.rewritesEnabled ? 'ON — launcher names will point at the cache' : 'saved but OFF (add --rewrites to enable)'}`);
  console.log('  saved. Restart the client (or use the GUI) to apply.');
}

function cmdRewrites(cfg, flags) {
  const arg = (flags._[0] || '').toLowerCase();
  if (!['on', 'off', 'status'].includes(arg)) {
    console.error('usage: stellardns-client rewrites on|off|status');
    process.exit(2);
  }
  if (arg === 'status') {
    const cats = Object.keys(cfg.categories || {});
    console.log(`  rewrites  ${cfg.rewritesEnabled ? 'ON' : 'OFF'}`);
    console.log(`  categories ${cats.length ? cats.join(', ') : 'none imported'}`);
    return;
  }
  cfg.rewritesEnabled = arg === 'on';
  save(cfg);
  console.log(`  rewrites ${cfg.rewritesEnabled ? 'enabled' : 'disabled'} — restart the client to apply`);
  if (cfg.rewritesEnabled) {
    console.log('  warning: every imported category now answers with its cache address.');
    console.log('  If that cache is unreachable, launcher downloads and some games will fail.');
  }
}

function cmdInstallService() {
  if (process.platform === 'linux') {
    const exec = process.argv[1];
    const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir, { recursive: true });
    const unit = `[Unit]
Description=StellarDNS encrypted DNS client
After=network-online.target

[Service]
ExecStart=${process.execPath} ${exec} run --no-dns
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`;
    const file = path.join(unitDir, 'stellardns-client.service');
    fs.writeFileSync(file, unit);
    console.log(`  wrote ${file}`);
    console.log('  enable it with:  systemctl --user daemon-reload && systemctl --user enable --now stellardns-client');
    console.log('  (port 53 needs root: either run the service system-wide, or keep --port 5353)');
    return;
  }
  if (process.platform === 'win32') {
    console.log('  Run an elevated prompt:');
    console.log(`    sc.exe create StellarDNS binPath= "${process.execPath} ${process.argv[1]} run" start= auto`);
    return;
  }
  console.log('  macOS: create ~/Library/LaunchAgents/com.stellardns.client.plist with ProgramArguments:');
  console.log(`    ${process.execPath} ${process.argv[1]} run`);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'run';
  const flags = parseFlags(argv.slice(1));
  const cfg = load();

  switch (cmd) {
    case 'run': return cmdRun(cfg, flags);
    case 'gui': return cmdRun(cfg, { ...flags, 'no-dns': true });
    case 'status': return cmdStatus(cfg);
    case 'test': return cmdTest(cfg, flags._[0], flags._[1]);
    case 'block': return cmdBlock(flags._[0], cfg);
    case 'unblock': return cmdUnblock(flags._[0], cfg);
    case 'refresh': { const l = await build(cfg, DATA_DIR, log); console.log(`  ${l.size} domains`); return; }
    case 'import': return cmdImport(cfg, flags);
    case 'rewrites': return cmdRewrites(cfg, flags);
    case 'set-dns': {
      const backup = sysdns.apply(cfg);
      cfg.systemDnsBackup = backup;
      cfg.setSystemDns = true;
      cfg.dnsPromptShown = true;      // asked and answered; do not prompt again in the GUI
      save(cfg);
      console.log('  system DNS -> 127.0.0.1 (previous value saved)');
      if (backup.elevated) console.log('  applied through the Windows elevation prompt');
      return;
    }
    case 'restore-dns': {
      const r = sysdns.restore(cfg.systemDnsBackup);
      if (r.restored) { cfg.systemDnsBackup = null; cfg.setSystemDns = false; save(cfg); console.log('  previous DNS restored'); }
      else console.log('  not restored: ' + r.reason);
      return;
    }
    case 'install-service': return cmdInstallService();
    case 'version': case '--version': console.log(VERSION); return;
    case 'help': case '--help': case '-h':
      console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n/, '').replace(/^\/\* ?/, '')); return;
    default:
      console.error(`unknown command: ${cmd}`);
      console.error('commands: run, status, test, block, unblock, refresh, set-dns, restore-dns, install-service, version');
      process.exit(2);
  }
}

main().catch(e => { console.error('fatal:', e.message); process.exit(1); });
