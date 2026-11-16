'use strict';
/* Encrypted transports.
 * DoH is RFC 8484 wire format over POST: no base64, no JSON, no transcoding, so the
 * packet the resolver sees is byte-identical to the one the stub produced.
 */
const https = require('https');
const tls = require('tls');

const agents = new Map();
function agentFor(hostname) {
  if (!agents.has(hostname)) {
    agents.set(hostname, new https.Agent({ keepAlive: true, maxSockets: 8, keepAliveMsecs: 30000 }));
  }
  return agents.get(hostname);
}

function dohQuery(up, packet, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const body = Buffer.isBuffer(packet) ? packet : Buffer.from(packet);
    const req = https.request({
      host: up.hostname,
      port: up.port || 443,
      path: up.path || '/dns-query',
      method: 'POST',
      agent: agentFor(up.hostname),
      timeout: timeoutMs,
      headers: {
        'content-type': 'application/dns-message',
        'accept': 'application/dns-message',
        'content-length': body.length,
        'user-agent': 'stellardns-client/26'
      }
    }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`${up.name}: HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const out = Buffer.concat(chunks);
        if (!out.length) return reject(new Error(`${up.name}: empty body`));
        resolve(out);
      });
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(new Error(`${up.name}: DoH timeout`)); });
    req.on('error', reject);
    req.end(body);
  });
}

/* DoT (RFC 7858) is length-prefixed on a single TLS connection. One socket per upstream,
 * queries serialised through a queue: a stub client sends tens of queries a minute, not
 * thousands, so a pool would add complexity for no gain.
 */
const dotPools = new Map();
function poolFor(up) {
  const key = `${up.hostname}:${up.port || 853}`;
  if (!dotPools.has(key)) dotPools.set(key, { sock: null, queue: [], buf: Buffer.alloc(0), connecting: false, inflight: null, up });
  return dotPools.get(key);
}

function dotQuery(up, packet, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const pool = poolFor(up);
    const entry = { packet: Buffer.isBuffer(packet) ? packet : Buffer.from(packet), resolve, reject, done: false };
    entry.timer = setTimeout(() => {
      if (entry.done) return;
      entry.done = true;
      const err = new Error(`${up.name}: DoT timeout`);
      reject(err);
      // A queued entry that timed out must not tear down a healthy in-flight exchange.
      if (pool.inflight !== entry) {
        const i = pool.queue.indexOf(entry);
        if (i >= 0) pool.queue.splice(i, 1);
        // But if the socket is still connecting and nothing was sent, the handshake itself is
        // the thing that wedged; without this the pool stays "connecting" forever.
        if (!pool.inflight && pool.connecting) {
          const stuck = pool.sock;
          pool.connecting = false;
          pool.sock = null;
          pool.buf = Buffer.alloc(0);
          try { if (stuck) stuck.destroy(); } catch {}
          failQueue(pool, err);
        }
        return;
      }
      // The in-flight query timed out: drop the connection state, including the stale
      // inflight slot and partial frame, or every later query waits for a reply forever.
      const sock = pool.sock;
      pool.inflight = null;
      pool.buf = Buffer.alloc(0);
      pool.sock = null; pool.connecting = false;
      try { if (sock) sock.destroy(); } catch {}
      failQueue(pool, err);
    }, timeoutMs);
    pool.queue.push(entry);
    pump(pool, up);
  });
}

function failQueue(pool, err) {
  for (const e of pool.queue.splice(0)) {
    if (e.done) continue;
    e.done = true; clearTimeout(e.timer); e.reject(err);
  }
}

function pump(pool, up) {
  if (pool.connecting || (pool.sock && pool.inflight)) return;
  if (!pool.queue.length) return;
  if (!pool.sock) {
    pool.connecting = true;
    const sock = tls.connect({ host: up.hostname, port: up.port || 853, servername: up.hostname, timeout: 5000 }, () => {
      if (pool.sock !== sock) return;
      pool.connecting = false;
      pump(pool, up);
    });
    pool.sock = sock;
    sock.on('data', d => {
      if (pool.sock !== sock) return;
      pool.buf = Buffer.concat([pool.buf, d]);
      while (pool.buf.length >= 2 && pool.buf.length >= 2 + pool.buf.readUInt16BE(0)) {
        const len = pool.buf.readUInt16BE(0);
        const msg = pool.buf.subarray(2, 2 + len);
        pool.buf = pool.buf.subarray(2 + len);
        const entry = pool.inflight;
        pool.inflight = null;
        if (entry && !entry.done) { entry.done = true; clearTimeout(entry.timer); entry.resolve(Buffer.from(msg)); }
      }
      pump(pool, up);
    });
    sock.on('error', e => {
      if (pool.sock !== sock) return;
      const entry = pool.inflight;
      pool.sock = null; pool.connecting = false; pool.inflight = null;
      pool.buf = Buffer.alloc(0);
      if (entry && !entry.done) { entry.done = true; clearTimeout(entry.timer); entry.reject(e); }
      failQueue(pool, e);
    });
    sock.on('close', () => {
      // A socket torn down by a timeout can close after a replacement is already connected;
      // it must not clear the new socket's state.
      if (pool.sock !== sock) return;
      pool.sock = null; pool.connecting = false;
      pool.buf = Buffer.alloc(0);
      if (pool.inflight) { const e = pool.inflight; pool.inflight = null; if (!e.done) { e.done = true; clearTimeout(e.timer); e.reject(new Error(`${up.name}: connection closed`)); } }
      pump(pool, up);
    });
    sock.on('timeout', () => { if (pool.sock === sock) sock.destroy(new Error(`${up.name}: socket timeout`)); });
    // Connection errors are delivered to the queued query, not thrown: the caller retries
    // the next upstream, which is the whole point of having more than one.
    return;
  }
  const entry = pool.queue.shift();
  if (!entry) return;
  if (entry.done) return pump(pool, up);
  pool.inflight = entry;
  const framed = Buffer.alloc(2 + entry.packet.length);
  framed.writeUInt16BE(entry.packet.length, 0);
  entry.packet.copy(framed, 2);
  pool.sock.write(framed);
}

function query(up, packet, timeoutMs) {
  if (up.protocol === 'tls') return dotQuery(up, packet, timeoutMs);
  return dohQuery(up, packet, timeoutMs);
}

module.exports = { query, dohQuery, dotQuery };
