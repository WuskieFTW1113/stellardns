'use strict';
/* Verify that the installer committed here carries the tree it claims to.
 *
 * 25.0.1 shipped a payload whose public/index.html was an older console with no Updates view.
 * The updater installs that file from the release tag, so it wrote a page without the panel
 * over a working one. This checks the payload against this checkout before anything ships.
 *
 *   node test/payload.js                  # ./stellardns-install.sh
 *   node test/payload.js path/to/build.sh # any other build
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MARKER = '#PAYLOAD_STARTS_HERE#';
const installer = path.resolve(process.argv[2] || path.join(ROOT, 'stellardns-install.sh'));

let failures = 0;
const ok = m => console.log('  ok   ' + m);
const bad = m => { failures++; console.log('  FAIL ' + m); };
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const lf = b => b.toString('utf8').replace(/\r\n/g, '\n');

// Minimal ustar reader: name/prefix/size/type at their fixed offsets, 512-byte blocks.
function readTar(gz) {
  const buf = zlib.gunzipSync(gz);
  const files = new Map();
  let off = 0;
  while (off + 512 <= buf.length) {
    const block = buf.subarray(off, off + 512);
    if (block.every(b => b === 0)) break;
    const name = block.subarray(0, 100).toString('utf8').replace(/\0.*$/, '').trim();
    const prefix = block.subarray(345, 500).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(block.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim() || '0', 8) || 0;
    const type = String.fromCharCode(block[156] || 48);
    off += 512;
    const data = buf.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
    if (type === '0' || type === '\0') files.set(prefix ? prefix + '/' + name : name, Buffer.from(data));
  }
  return files;
}

let text;
try { text = fs.readFileSync(installer, 'utf8'); }
catch (e) { console.error('cannot read ' + installer + ': ' + e.message); process.exit(2); }
console.log('installer: ' + path.relative(process.cwd(), installer));

const at = text.lastIndexOf(MARKER);
if (at < 0) { console.error('  FAIL no ' + MARKER + ' in the file'); process.exit(1); }
const gz = Buffer.from(text.slice(at + MARKER.length).replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
const header = {};
for (const line of text.slice(0, at).split('\n')) {
  const m = line.match(/^([A-Z_]+)="([^"]*)"$/);
  if (m) header[m[1]] = m[2];
}

let files;
try { files = readTar(gz); } catch (e) { bad('payload is not readable gzip/tar: ' + e.message); process.exit(1); }
ok(files.size + ' files in payload');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const names = [...files.keys()];
const pick = suffix => {
  const key = names.find(n => n === 'stellardns/' + suffix)
    || names.find(n => n.split('/').length === 2 && n.endsWith('/' + suffix))
    || names.find(n => n.endsWith('/' + suffix));
  return key ? files.get(key) : undefined;
};

// Header vs payload integrity.
if (!header.EXPECTED_SHA) bad('installer header has no EXPECTED_SHA');
else if (header.EXPECTED_SHA !== sha(gz)) bad('payload does not match the installer\'s EXPECTED_SHA');
else ok('payload matches EXPECTED_SHA');

// Version agreement: header, package.json and the payload's server.js.
const server = pick('server.js');
const html = pick('public/index.html');
const payloadVersion = server && (server.toString('utf8').match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/) || [])[1];

if (header.VERSION !== pkg.version) bad('installer VERSION "' + header.VERSION + '" != package.json "' + pkg.version + '"');
else ok('installer VERSION is ' + pkg.version);

if (!server) bad('payload has no server.js');
else if (!payloadVersion) bad('payload server.js has no APP_VERSION');
else if (payloadVersion !== pkg.version) bad('payload server.js is ' + payloadVersion + ', package.json is ' + pkg.version);
else ok('payload server.js is ' + payloadVersion);

if (!header.BUILD) bad('installer header has no BUILD stamp'); else ok('build ' + header.BUILD);

// The console: present, contains the Updates view, and identical to the committed one.
if (!html) bad('payload has no public/index.html');
else {
  if (!/update\/state/.test(html.toString('utf8'))) bad('payload console has no Updates view (no update/state)');
  else ok('payload console contains the Updates view');

  const repoHtml = path.join(ROOT, 'public', 'index.html');
  const repoBuf = fs.existsSync(repoHtml) ? fs.readFileSync(repoHtml) : null;
  if (!repoBuf) bad('this checkout has no public/index.html');
  else if (!/update\/state/.test(repoBuf.toString('utf8'))) bad('committed public/index.html has no Updates view');
  else if (sha(Buffer.from(lf(html))) !== sha(Buffer.from(lf(repoBuf)))) bad('payload console differs from public/index.html');
  else ok('payload console matches public/index.html');
}

// The payload must still parse as JavaScript.
if (server) {
  const tmp = path.join(os.tmpdir(), 'stellardns-payload-' + process.pid + '.js');
  fs.writeFileSync(tmp, server);
  const res = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
  fs.rmSync(tmp, { force: true });
  if (res.status !== 0) bad('payload server.js fails node --check: ' + String(res.stderr || '').trim().split('\n')[0]);
  else ok('payload server.js passes node --check');
}

if (failures) { console.log('\npayload check failed: ' + failures + ' problem(s)'); process.exit(1); }
console.log('\npayload ok');
