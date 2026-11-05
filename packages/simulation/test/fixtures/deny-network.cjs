// Network-denial preload for offline-replay verification.
// Loaded via NODE_OPTIONS=--require=<this file> to actively deny all network
// access before the CLI starts, proving `npm run sim` never needs the network.
'use strict';

const deny = () => {
  throw new Error('NETWORK_DENIED: offline replay must not touch the network');
};
globalThis.fetch = deny;
globalThis.WebSocket = deny;

for (const name of ['node:http', 'node:https']) {
  const mod = require(name);
  mod.request = deny;
  mod.get = deny;
}
const net = require('node:net');
net.connect = deny;
net.createConnection = deny;
if (net.Socket && net.Socket.prototype) net.Socket.prototype.connect = deny;
const tls = require('node:tls');
tls.connect = deny;
const dns = require('node:dns');
dns.lookup = deny;
dns.resolve = deny;
require('node:module').syncBuiltinESMExports();
