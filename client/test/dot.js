'use strict';
/* DoT reconnect regression.
 *
 * A TLS handshake that never completes used to leave the pool's `connecting` flag set, so
 * every later query queued behind a socket that would never open. The pool also did not
 * clear its in-flight entry or partial frame after a query timeout. This stubs tls.connect
 * with a socket that never emits secureConnect and proves the next query opens a new one.
 */
const assert = require('assert');
const EventEmitter = require('events');
const tls = require('tls');

const realConnect = tls.connect;
const sockets = [];
tls.connect = () => {
  const sock = new EventEmitter();
  sock.write = () => true;
  sock.destroy = () => setImmediate(() => sock.emit('close'));
  sock.setTimeout = () => sock;
  sockets.push(sock);
  return sock;
};

const { dotQuery } = require('../src/doh');

(async () => {
  const up = { name: 'test-dot', protocol: 'tls', hostname: 'example.test', port: 8853 };
  const packet = Buffer.from([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

  await assert.rejects(dotQuery(up, packet, 30), /DoT timeout/);
  assert.strictEqual(sockets.length, 1, 'first query should make one connection attempt');

  await assert.rejects(dotQuery(up, packet, 30), /DoT timeout/);
  assert.strictEqual(sockets.length, 2, 'second query should reconnect instead of reusing the stalled socket');

  tls.connect = realConnect;
  console.log('  PASS  DoT pool reconnects after a stalled handshake');
  process.exit(0);
})().catch(e => {
  tls.connect = realConnect;
  console.error('  FAIL  ' + e.message);
  process.exit(1);
});
