#!/usr/bin/env node
// npm run mock -- [--port 16622] [--host 127.0.0.1] [--rgb] [--api 1.16.0]
// Starts a pretend Companion with show-style buttons. Point the module at 127.0.0.1 (and the port).
// --rgb behaves like Companion 3, which sends raw RGB bitmaps and no CAPS.

import { parseArgs } from 'node:util';
import { MockCompanion } from './mock.js';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '16622' },
    host: { type: 'string', default: '127.0.0.1' },
    rgb: { type: 'boolean', default: false },
    api: { type: 'string', default: '1.16.0' }
  },
  // The module starts Companion with its own flags (--admin-port and so on); ignore those.
  strict: false
});

const mock = new MockCompanion({ png: !values.rgb, apiVersion: String(values.api) });
const port = await mock.listen(Number(values.port), String(values.host));
console.log(`Mock Companion (Satellite API ${values.api}${values.rgb ? ', RGB bitmaps' : ''}) on ${values.host}:${port}. Ctrl-C to stop.`);
let last = 0;
setInterval(() => {
  if (mock.presses.length !== last) {
    for (const p of mock.presses.slice(last)) console.log(`${p.pressed ? 'press  ' : 'release'} ${p.device} key ${p.key + 1}`);
    last = mock.presses.length;
  }
}, 200);
process.on('SIGTERM', () => void mock.close().then(() => process.exit(0)));
