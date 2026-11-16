'use strict';
/* Point the operating system at the local resolver, and put it back afterwards.
 * Every command here is reversible and the previous value is written to config before the
 * change, so a crash between the two leaves a record of what to restore.
 *
 * On Windows a standard user cannot change an adapter's DNS, so the change is retried through
 * a UAC prompt. That is the difference between a prompt that works and one that just says
 * "access denied" - but it is still the user's click that authorises it.
 *
 * Two Windows details this file exists to get right:
 *  - The adapter to change is the one with the default route, not the lowest ifIndex and not
 *    one called "Wi-Fi". A laptop with a dock or a virtual switch has several Up adapters.
 *  - IPv6 DNS is set too. A router that advertises its own IPv6 resolver would otherwise
 *    answer first and the filter would never see the query.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function ipv4s(text) {
  return Array.from(new Set(String(text || '').match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) || []));
}

function currentLinux() {
  try {
    if (fs.existsSync('/run/systemd/resolve/resolv.conf')) {
      const txt = fs.readFileSync('/run/systemd/resolve/resolv.conf', 'utf8');
      return txt.split('\n').filter(l => l.startsWith('nameserver')).map(l => l.split(/\s+/)[1]).join(',');
    }
  } catch {}
  try {
    return fs.readFileSync('/etc/resolv.conf', 'utf8')
      .split('\n').filter(l => l.startsWith('nameserver')).map(l => l.split(/\s+/)[1]).join(',');
  } catch { return ''; }
}

/* ---------------------------------- Windows ---------------------------------- */

const PS = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function psRun(script) {
  return run(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
}

function lastJson(text) {
  // PowerShell can print a warning after the JSON; take the last line that is an object, not
  // simply the last line.
  const lines = String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const line = lines.reverse().find(l => l.startsWith('{')) || '{}';
  try { return JSON.parse(line); }
  catch { throw new Error('could not read PowerShell output: ' + line.slice(0, 200)); }
}

function isAdmin() {
  if (process.env.STELLARDNS_ASSUME_ADMIN === '1') return true;
  try {
    return /true/i.test(psRun(
      '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent())' +
      '.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'));
  } catch { return false; }
}

/* The interface that carries traffic: the one holding the IPv4 default route. `Get-NetAdapter
 * -Physical | Sort ifIndex | First` chose a Hyper-V switch or the Ethernet port on machines
 * where Wi-Fi was the only connected link, because ifIndex ordering has nothing to do with
 * routing. */
function winAdapter() {
  if (process.env.STELLARDNS_IFACE) return { alias: process.env.STELLARDNS_IFACE, index: 0, v6: true };
  // Windows ranks default routes by RouteMetric + InterfaceMetric, so this picks the adapter
  // the stack actually uses. Two traps it avoids: a disconnected adapter can still carry a
  // route (the machine this was tested on has one), and a VPN client installs a second default
  // route that wins on plain RouteMetric ties.
  const script = [
    "$routes = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object { $_.RouteMetric + $_.InterfaceMetric }",
    "$pick = $null",
    "foreach ($r in $routes) { $a = Get-NetAdapter -InterfaceIndex $r.ifIndex -ErrorAction SilentlyContinue; if ($a -and $a.Status -eq 'Up') { $pick = Get-NetIPConfiguration -InterfaceIndex $r.ifIndex; break } }",
    "if ($pick) { [pscustomobject]@{ alias=$pick.InterfaceAlias; index=[int]$pick.InterfaceIndex; v6=[bool]$pick.IPv6DefaultGateway } | ConvertTo-Json -Compress }"
  ].join('; ');
  const info = lastJson(psRun(script));
  if (!info.alias) throw new Error('no connected network adapter was found (Wi-Fi or Ethernet)');
  return info;
}

/* Structured read-back. Parsing `netsh` text meant a localized Windows or a renamed adapter
 * looked like a failed change even when it had worked. */
function winDns(alias, family) {
  const script = `@((Get-DnsClientServerAddress -InterfaceAlias ${psQuote(alias)} ` +
    `-AddressFamily ${family}).ServerAddresses | Where-Object { $_ }) -join ','`;
  try { return psRun(script).trim(); } catch { return ''; }
}

/* Run a .ps1 by path, optionally elevated. The script is a file rather than -Command so no
 * quoting layer has to survive Start-Process: a misspelled argument list here is exactly how
 * "access denied" turns into "nothing happened". */
function runScript(body, elevated) {
  const file = path.join(os.tmpdir(), `stellardns-dns-${process.pid}-${Date.now()}.ps1`);
  // A BOM, because Windows PowerShell 5.1 reads a BOM-less .ps1 as the ANSI code page. An
  // adapter called "Wi-Fi" survives that; one with an accent in its name does not, and the
  // failure reads as a parse error rather than a bad alias.
  fs.writeFileSync(file, '\uFEFF' + body, 'utf8');
  try {
    if (!elevated) {
      return run(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file]);
    }
    const quoted = '"' + file + '"';
    const argList = ["'-NoProfile'", "'-ExecutionPolicy'", "'Bypass'", "'-File'", psQuote(quoted)].join(',');
    const script =
      `$p = Start-Process -FilePath ${psQuote(PS)} -ArgumentList @(${argList}) -Verb RunAs -Wait -PassThru -WindowStyle Hidden; ` +
      'exit $p.ExitCode';
    try {
      return run(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
    } catch (e) {
      const msg = String((e && (e.stderr || e.message)) || '');
      if (/canceled|cancelled|1223|operation was canceled/i.test(msg)) {
        throw new Error('the elevation prompt was cancelled');
      }
      const first = msg.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0] || 'unknown error';
      throw new Error('elevation failed: ' + first);
    }
  } finally {
    try { fs.unlinkSync(file); } catch {}
  }
}

function winApply() {
  const adapter = winAdapter();
  const v6 = adapter.v6 === true && process.env.STELLARDNS_NO_IPV6 !== '1';
  const resultFile = path.join(os.tmpdir(), `stellardns-dns-${process.pid}-${Date.now()}.json`);
  const body = [
    "$ErrorActionPreference = 'Stop'",
    `$alias = ${psQuote(adapter.alias)}`,
    `$out = ${psQuote(resultFile)}`,
    "$b4 = @((Get-DnsClientServerAddress -InterfaceAlias $alias -AddressFamily IPv4).ServerAddresses | Where-Object { $_ })",
    "$b6 = @((Get-DnsClientServerAddress -InterfaceAlias $alias -AddressFamily IPv6).ServerAddresses | Where-Object { $_ })",
    "Set-DnsClientServerAddress -InterfaceAlias $alias -AddressFamily IPv4 -ServerAddresses @('127.0.0.1')",
    v6 ? "Set-DnsClientServerAddress -InterfaceAlias $alias -AddressFamily IPv6 -ServerAddresses @('::1')" : '',
    "$a4 = @((Get-DnsClientServerAddress -InterfaceAlias $alias -AddressFamily IPv4).ServerAddresses | Where-Object { $_ })",
    "$a6 = @((Get-DnsClientServerAddress -InterfaceAlias $alias -AddressFamily IPv6).ServerAddresses | Where-Object { $_ })",
    "[pscustomobject]@{ before4=($b4 -join ','); before6=($b6 -join ','); after4=($a4 -join ','); after6=($a6 -join ',') } | " +
      "ConvertTo-Json -Compress | Set-Content -Path $out -Encoding UTF8"
  ].filter(Boolean).join('\r\n');

  // Test hook: build the script, run nothing. The suites use it to prove the generated
  // PowerShell parses, which is the part a user cannot check after it fails at the prompt.
  if (process.env.STELLARDNS_DNS_DRYRUN === '1') return { dryRun: true, iface: adapter.alias, script: body };

  const elevated = !isAdmin();
  runScript(body, elevated);

  let result = null;
  try { result = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch {}
  try { fs.unlinkSync(resultFile); } catch {}

  if (!result) {
    throw new Error(`Windows did not report the result for "${adapter.alias}"` +
      (elevated ? ' - the elevation prompt may have been declined' : ''));
  }
  if (!String(result.after4 || '').includes('127.0.0.1')) {
    throw new Error(`"${adapter.alias}" still resolves against ${result.after4 || 'nothing'}; ` +
      'another program may be enforcing DNS settings');
  }
  if (v6 && !String(result.after6 || '').includes('::1')) {
    throw new Error(`"${adapter.alias}" did not accept ::1 for IPv6; ` +
      'another program may be enforcing DNS settings');
  }

  return {
    platform: 'win32',
    iface: adapter.alias,
    before: result.before4 || '',
    before4: result.before4 || '',
    before6: v6 ? (result.before6 || '') : '',
    v6,
    elevated,
    at: new Date().toISOString()
  };
}

function winRestore(backup) {
  const alias = backup.iface;
  if (!alias) return { restored: false, reason: 'no adapter recorded' };
  const split = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
  const v4 = split(backup.before4 !== undefined ? backup.before4 : backup.before);
  const v6 = backup.v6 ? split(backup.before6) : null;

  const setFamily = (family, list) => {
    if (list === null) return '';
    if (!list.length) {
      return `Set-DnsClientServerAddress -InterfaceAlias $alias -AddressFamily ${family} -ResetServerAddresses`;
    }
    return `Set-DnsClientServerAddress -InterfaceAlias $alias -AddressFamily ${family} -ServerAddresses @(${list.map(psQuote).join(',')})`;
  };

  const body = [
    "$ErrorActionPreference = 'Stop'",
    `$alias = ${psQuote(alias)}`,
    setFamily('IPv4', v4),
    setFamily('IPv6', v6)
  ].filter(Boolean).join('\r\n');

  runScript(body, !isAdmin());

  const after4 = winDns(alias, 'IPv4');
  if (v4.length && !v4.every(ip => after4.split(',').includes(ip))) {
    throw new Error(`"${alias}" is still using ${after4 || 'an unknown server'}`);
  }
  if (v6 && v6.length) {
    const after6 = winDns(alias, 'IPv6');
    if (!v6.every(ip => after6.split(',').includes(ip))) {
      throw new Error(`"${alias}" still has ${after6 || 'no IPv6 server'} for IPv6`);
    }
  }
  return { restored: true, servers: v4 };
}

/* Which process holds a port, so "port 53 is busy" can name the program instead of guessing.
 * Only reads netstat output, so it needs no elevation. */
function portOwner(port) {
  if (process.platform !== 'win32') return null;
  const wanted = Number(port);
  for (const args of [['-ano', '-p', 'UDP'], ['-ano', '-p', 'TCP']]) {
    let out = '';
    try { out = run('netstat', args); } catch { continue; }
    for (const line of out.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4 || !/^(UDP|TCP)$/i.test(parts[0])) continue;
      const m = parts[1].match(/:(\d+)$/);
      if (!m || Number(m[1]) !== wanted) continue;
      const pid = Number(parts[parts.length - 1]);
      if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) continue;
      let name = '';
      try {
        const csv = run('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV']);
        name = (csv.split(',')[0] || '').replace(/"/g, '');
      } catch {}
      return { pid, name };
    }
  }
  return null;
}

/* ---------------------------------- public ---------------------------------- */

function apply(cfg) {
  const target = '127.0.0.1';
  if (process.platform === 'win32') return winApply();

  if (process.platform === 'darwin') {
    const services = run('networksetup', ['-listallnetworkservices']).split('\n').filter(l => l && !l.startsWith('*'));
    const service = process.env.STELLARDNS_SERVICE || services[0];
    if (!service) throw new Error('no network service found');
    const before = run('networksetup', ['-getdnsservers', service]);
    run('networksetup', ['-setdnsservers', service, target]);
    return { platform: 'darwin', service, before, elevated: false };
  }

  // Linux: prefer resolved, because writing resolv.conf directly is overwritten by it.
  let resolved = false;
  try { run('systemctl', ['is-active', 'systemd-resolved']); resolved = true; } catch {}
  if (resolved) {
    const iface = process.env.STELLARDNS_IFACE || (() => {
      try { return run('sh', ['-c', "ip route show default | awk '{print $5; exit}'"]); } catch { return 'eth0'; }
    })();
    const before = currentLinux();
    run('resolvectl', ['dns', iface, target]);
    run('resolvectl', ['domain', iface, '~.']);
    return { platform: 'linux-resolved', iface, before, elevated: false };
  }
  const before = currentLinux();
  try { fs.copyFileSync('/etc/resolv.conf', '/etc/resolv.conf.stellardns.bak'); } catch {}
  fs.writeFileSync('/etc/resolv.conf', `# managed by stellardns-client\nnameserver ${target}\n`);
  return { platform: 'linux-resolv', before, elevated: false };
}

function restore(backup) {
  if (!backup) return { restored: false, reason: 'no backup recorded' };
  if (backup.platform === 'win32') {
    try { return winRestore(backup); }
    catch (e) { return { restored: false, reason: e.message }; }
  }
  if (backup.platform === 'darwin') {
    const servers = (backup.before || '').split(/\n/).filter(l => l && !/There aren't any/.test(l));
    run('networksetup', ['-setdnsservers', backup.service, ...(servers.length ? servers : ['Empty'])]);
    return { restored: true };
  }
  if (backup.platform === 'linux-resolved') {
    try { run('resolvectl', ['revert', backup.iface]); } catch {}
    return { restored: true };
  }
  if (backup.platform === 'linux-resolv') {
    try { fs.copyFileSync('/etc/resolv.conf.stellardns.bak', '/etc/resolv.conf'); return { restored: true }; }
    catch { return { restored: false, reason: 'no /etc/resolv.conf.stellardns.bak' }; }
  }
  return { restored: false, reason: 'unknown backup format' };
}

module.exports = {
  apply,
  restore,
  current: currentLinux,
  portOwner,
  adapter: process.platform === 'win32' ? winAdapter : () => null
};
