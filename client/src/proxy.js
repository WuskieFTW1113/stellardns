'use strict';
/* The local resolver.
 * One UDP and one TCP listener on loopback, answering from a small TTL cache, filtering
 * against the blocklist, and forwarding everything else over DoH/DoT. It is not a recursive
 * resolver and it never listens on a routable address by default.
 */
const dgram = require('dgram');
const net = require('net');
const dnsPacket = require('dns-packet');
const { query } = require('./doh');

const RCODE_NXDOMAIN = 3;

// A category maps every domain it owns to one address, including subdomains. Flat map plus
// a suffix walk, same shape as the blocklist, because the matching question is identical.
function buildRewriteIndex(categories) {
  const index = new Map();
  for (const [name, c] of Object.entries(categories || {})) {
    if (!c || c.enabled === false) continue;
    for (const d of c.domains || []) {
      const key = String(d).toLowerCase().replace(/\.$/, '');
      if (key && !index.has(key)) index.set(key, { target: c.target || '', target6: c.target6 || '', category: name });
    }
  }
  return index;
}

function suffixLookup(index, name) {
  let i = 0;
  while (i < name.length) {
    const candidate = name.slice(i);
    if (index.has(candidate)) return index.get(candidate);
    const dot = name.indexOf('.', i);
    if (dot === -1) break;
    i = dot + 1;
  }
  return null;
}

class Resolver {
  constructor(cfg, blocklist) {
    this.cfg = cfg;
    this.blocklist = blocklist;
    this.cache = new Map();
    this.stats = { queries: 0, cacheHits: 0, blocked: 0, rewrites: 0, forwarded: 0, failed: 0, startedAt: Date.now(), lastError: '', lastUpstream: '' };
    this.upstreams = (cfg.upstreams || []).slice();
    this.blocking = cfg.blockingEnabled !== false;
    this.rewrite = buildRewriteIndex(cfg.categories);
    this.rewritesEnabled = cfg.rewritesEnabled === true;
  }

  // Called after a rules import or a settings change, so the next query uses them without a
  // restart. The blocklist itself is rebuilt by the caller because it needs the network.
  reload(cfg) {
    this.cfg = cfg;
    this.blocking = cfg.blockingEnabled !== false;
    this.upstreams = (cfg.upstreams || []).slice();
    this.rewrite = buildRewriteIndex(cfg.categories);
    this.rewritesEnabled = cfg.rewritesEnabled === true;
    this.cache.clear();
  }

  key(question) { return `${question.name.toLowerCase().replace(/\.$/, '')}|${question.type}`; }

  cacheGet(k) {
    const hit = this.cache.get(k);
    if (!hit) return null;
    if (hit.expires <= Date.now()) { this.cache.delete(k); return null; }
    // Returning the packet stored at insertion time would tell the stub (and anything behind
    // it) that a 120s answer is still fresh after 100s, so its cache outlives this one.
    const age = Math.floor((Date.now() - hit.at) / 1000);
    if (age <= 0) return hit.packet;
    try {
      const decoded = dnsPacket.decode(hit.packet);
      for (const rr of [...(decoded.answers || []), ...(decoded.authority || []), ...(decoded.additionals || [])]) {
        if (typeof rr.ttl === 'number') rr.ttl = Math.max(1, rr.ttl - age);
      }
      return dnsPacket.encode(decoded);
    } catch { return hit.packet; }
  }

  cachePut(k, packet, ttlSec) {
    const ttl = Math.max(this.cfg.ttlMin || 30, Math.min(this.cfg.ttlMax || 3600, ttlSec || 60));
    if (this.cache.size >= (this.cfg.cacheMaxEntries || 20000)) {
      // Cheap eviction: Map preserves insertion order, so drop the oldest 200.
      let n = 0;
      for (const key of this.cache.keys()) { this.cache.delete(key); if (++n >= 200) break; }
    }
    const now = Date.now();
    this.cache.set(k, { packet, expires: now + ttl * 1000, at: now });
  }

  blockedReply(msg, question) {
    const base = {
      type: 'response',
      id: msg.readUInt16BE(0),
      flags: dnsPacket.RECURSION_DESIRED | dnsPacket.RECURSION_AVAILABLE,
      questions: [question],
      answers: []
    };
    if ((this.cfg.blockResponse || 'nxdomain') === 'zeroip') {
      if (question.type === 'A') base.answers = [{ name: question.name, type: 'A', ttl: 60, class: 'IN', data: '0.0.0.0' }];
      else if (question.type === 'AAAA') base.answers = [{ name: question.name, type: 'AAAA', ttl: 60, class: 'IN', data: '::' }];
      return dnsPacket.encode(base);
    }
    const buf = dnsPacket.encode(base);
    // dns-packet does not expose an rcode option on encode in every version, and the field
    // is four bits of header byte 3 — set it directly rather than depend on the version.
    buf[3] = (buf[3] & 0xf0) | RCODE_NXDOMAIN;
    return buf;
  }

  async forward(msg) {
    let lastErr = null;
    for (const up of this.upstreams) {
      try {
        const out = await query(up, msg, 5000);
        this.stats.lastUpstream = up.name;
        return out;
      } catch (e) {
        lastErr = e;
        this.stats.lastError = e.message;
      }
    }
    throw lastErr || new Error('no upstreams configured');
  }

  async handle(msg) {
    this.stats.queries++;
    let decoded;
    try { decoded = dnsPacket.decode(msg); } catch { this.stats.failed++; return null; }
    const question = (decoded.questions || [])[0];
    if (!question) return null;
    const name = question.name.replace(/\.$/, '');

    if (this.blocking !== false && this.blocklist) {
      const matched = this.blocklist.match(name);
      if (matched) { this.stats.blocked++; return this.blockedReply(msg, question); }
    }

    if (this.rewritesEnabled) {
      const rewrite = suffixLookup(this.rewrite, name.toLowerCase());
      if (rewrite) {
        const reply = this.rewriteReply(msg, question, rewrite);
        if (reply) { this.stats.rewrites++; return reply; }
      }
    }

    const k = this.key(question);
    const cached = this.cacheGet(k);
    if (cached) {
      this.stats.cacheHits++;
      const out = Buffer.from(cached);
      out.writeUInt16BE(msg.readUInt16BE(0), 0);   // fresh id, same answer
      return out;
    }

    try {
      const out = await this.forward(msg);
      this.stats.forwarded++;
      let ttl = 60;
      try {
        const r = dnsPacket.decode(out);
        const ttls = (r.answers || []).map(a => a.ttl).filter(n => typeof n === 'number');
        if (ttls.length) ttl = Math.min(...ttls);
        if (r.rcode === 'NOERROR' && !(r.answers || []).length && r.authority && r.authority.length) {
          const soa = r.authority.find(a => a.type === 'SOA');
          if (soa && soa.data && soa.data.minimum) ttl = Math.min(soa.data.minimum, 900);
        }
      } catch {}
      // Never cache SERVFAIL: the resolver above us was having a bad second, and caching
      // that turns a blip into minutes of failure. A truncated response is likewise a fact
      // about the transport, not a complete answer; caching it serves a cut-off packet from
      // cache long after a retry over TCP could have filled it in.
      const rcode = out.length > 3 ? (out[3] & 0x0f) : 0;
      const truncated = out.length > 2 && (out[2] & 0x02) !== 0;
      if (!truncated && (rcode === 0 || rcode === RCODE_NXDOMAIN)) this.cachePut(k, out, ttl);
      return out;
    } catch (e) {
      this.stats.failed++;
      this.stats.lastError = e.message;
      // SERVFAIL, not silence. A dropped query makes every app wait out its own timeout; an
      // explicit failure is immediate and tells the resolver above us to try elsewhere.
      return this.failReply(msg, question);
    }
  }

  failReply(msg, question) {
    const base = {
      type: 'response',
      id: msg.readUInt16BE(0),
      flags: dnsPacket.RECURSION_DESIRED | dnsPacket.RECURSION_AVAILABLE,
      questions: question ? [question] : [],
      answers: []
    };
    const buf = dnsPacket.encode(base);
    buf[3] = (buf[3] & 0xf0) | 2;          // rcode SERVFAIL
    return buf;
  }

  // A category answers A from its v4 target and AAAA from its v6 target. No v6 target means
  // NODATA — the name exists and simply has no AAAA, which is what a real zone would say.
  rewriteReply(msg, question, rewrite) {
    const type = question.type;
    if (type !== 'A' && type !== 'AAAA') return null;
    const data = type === 'A' ? rewrite.target : rewrite.target6;
    const base = {
      type: 'response', id: msg.readUInt16BE(0),
      flags: dnsPacket.RECURSION_DESIRED | dnsPacket.RECURSION_AVAILABLE,
      questions: [question], answers: []
    };
    if (!data) return type === 'AAAA' ? dnsPacket.encode(base) : null;
    base.answers = [{ name: question.name, type, ttl: 60, class: 'IN', data }];
    return dnsPacket.encode(base);
  }

  flush() { const n = this.cache.size; this.cache.clear(); return n; }
}

function listenPair(resolver, host, port, family, log) {
  const udp = dgram.createSocket(family === 6 ? 'udp6' : 'udp4');
  const tcp = net.createServer(sock => {
    let buf = Buffer.alloc(0);
    sock.on('data', async d => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
        const len = buf.readUInt16BE(0);
        const msg = buf.subarray(2, 2 + len);
        buf = buf.subarray(2 + len);
        const out = await resolver.handle(msg);
        if (out) {
          const framed = Buffer.alloc(2 + out.length);
          framed.writeUInt16BE(out.length, 0);
          out.copy(framed, 2);
          sock.write(framed);
        }
      }
    });
    sock.on('error', () => {});
    sock.setTimeout(15000, () => sock.destroy());
  });

  return new Promise((resolve, reject) => {
    // Only startup errors reject; a later socket error must not tear down a listener that is
    // already answering queries.
    const fail = e => {
      try { udp.close(); } catch {}
      try { tcp.close(); } catch {}
      reject(e);
    };
    udp.once('error', fail);
    udp.on('message', async (msg, rinfo) => {
      const out = await resolver.handle(msg);
      if (out) udp.send(out, rinfo.port, rinfo.address);
    });
    udp.bind(port, host, () => {
      udp.removeListener('error', fail);
      udp.on('error', () => {});
      tcp.once('error', fail);
      tcp.listen(port, host, () => {
        tcp.removeListener('error', fail);
        tcp.on('error', () => {});
        log('listen', `resolver on ${family === 6 ? `[${host}]` : host}:${port} (udp+tcp)`);
        resolve({
          close() { try { udp.close(); } catch {} try { tcp.close(); } catch {} }
        });
      });
    });
  });
}

/* Loopback only, both families. A Windows machine with an IPv6 default route also has IPv6
 * DNS from the router; if only 127.0.0.1 is answered, those queries never reach the filter. */
async function startListeners(resolver, cfg, log = () => {}) {
  const host = (cfg.listen && cfg.listen.host) || '127.0.0.1';
  const port = Number((cfg.listen && cfg.listen.port) || 53);
  const handles = [];
  if (!host.includes(':')) handles.push(await listenPair(resolver, host, port, 4, log));
  try {
    handles.push(await listenPair(resolver, host.includes(':') ? host : '::1', port, 6, log));
  } catch (e) {
    if (host.includes(':')) throw e;
    log('warn', `IPv6 loopback listener unavailable (${e.code || e.message})`);
  }
  return { close() { for (const h of handles) h.close(); } };
}

module.exports = { Resolver, startListeners };
