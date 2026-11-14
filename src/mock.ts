// A pretend Companion that speaks the Satellite API, for tests and for working on the module without
// a show machine. It draws simple buttons (a colour and a pixel-font label), latches the ones marked
// as toggles, and records every press it is sent.

import net from 'node:net';
import { encodePng } from './png.js';
import { formatLine, LineReader, parseLine, truthy } from './protocol.js';

export interface MockOptions {
  companionVersion?: string;
  apiVersion?: string;
  /** Send CAPS and accept BITMAP_FORMAT=png, as Companion 4 does. Off: raw RGB only. */
  png?: boolean;
  /** Refuse ADD-DEVICE for these DEVICEIDs. */
  refuse?: string[];
}

interface Device {
  id: string;
  socket: net.Socket;
  columns: number;
  rows: number;
  bitmap: number;
  png: boolean;
  text: boolean;
  colors: boolean;
  latched: Set<number>;
  held: Set<number>;
}

export interface Press {
  device: string;
  key: number;
  pressed: boolean;
}

// What the mock shows: [label, colour, latches]. Keys surfaces get KEYS, anything else TOUCH.
const KEYS: [string, string, boolean][] = [
  ['CUT', '#5A1E1E', false], ['AUTO', '#5A1E1E', false], ['FTB', '#2A2F37', true], ['DSK 1', '#2A2F37', true], ['MACRO 1', '#2E2440', false],
  ['PVW 1', '#2A2F37', true], ['PVW 2', '#2A2F37', true], ['PVW 3', '#2A2F37', true], ['PVW 4', '#2A2F37', true], ['PVW 5', '#2A2F37', true],
  ['PAGE UP', '#1B1E23', false], ['PAGE 1', '#1B1E23', false], ['PAGE DN', '#1B1E23', false], ['TALLY', '#1B1E23', false], ['CLOCK', '#1B1E23', false]
];
const TOUCH: [string, string, boolean][] = [
  ['CAM 1', '#1F6F43', true], ['CAM 2', '#2A2F37', true], ['CAM 3', '#2A2F37', true], ['CAM 4', '#2A2F37', true],
  ['GFX', '#2A2F37', true], ['PLAYBACK', '#2A2F37', true], ['REC', '#5A1E1E', true], ['STREAM', '#5A1E1E', true],
  ['LIGHTS 1', '#3A3320', false], ['LIGHTS 2', '#3A3320', false], ['HOUSE UP', '#3A3320', false], ['HOUSE DN', '#3A3320', false],
  ['MIC 1', '#20304A', true], ['MIC 2', '#20304A', true], ['WALK-IN', '#2E2440', true], ['TIMER', '#1B1E23', false],
  ['SCENE A', '#3A3320', false], ['SCENE B', '#3A3320', false], ['HAZE', '#2E2440', true], ['NEXT', '#20304A', false],
  ['PREV', '#20304A', false], ['BLACK', '#5A1E1E', true], ['AUX 1', '#2A2F37', false], ['AUX 2', '#2A2F37', false],
  ['CUE 1', '#1F4A4A', false], ['CUE 2', '#1F4A4A', false], ['CUE 3', '#1F4A4A', false], ['GO', '#1F6F43', false],
  ['VOL UP', '#20304A', false], ['VOL DN', '#20304A', false], ['MUSIC', '#20304A', true], ['PTZ WIDE', '#2E2440', false],
  ['PTZ TIGHT', '#2E2440', false], ['RECALL', '#3A3320', false], ['AUX 3', '#2A2F37', false], ['AUX 4', '#2A2F37', false]
];
const ON = '#E5484D';
const HELD = '#F5A524';

export class MockCompanion {
  readonly devices = new Map<string, Device>();
  readonly presses: Press[] = [];
  /** Every line received apart from PING and PONG. */
  readonly received: string[] = [];
  /** Stops answering anything, PING included. */
  silent = false;
  private server: net.Server | null = null;
  private sockets = new Set<net.Socket>();

  constructor(readonly opts: MockOptions = {}) {}

  listen(port = 16622, host = '127.0.0.1'): Promise<number> {
    const server = net.createServer((s) => this.accept(s));
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve((server.address() as net.AddressInfo).port));
    });
  }

  async close(): Promise<void> {
    this.dropClients();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  dropClients(): void {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    this.devices.clear();
  }

  /** What the mock is drawing on one key, as its label and colour. */
  face(device: string, key: number): { label: string; color: string } {
    const d = this.devices.get(device);
    const [label, color, latches] = button(device, key);
    const on = d?.held.has(key) ? HELD : latches && d?.latched.has(key) ? ON : color;
    return { label, color: on };
  }

  private accept(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.setEncoding('utf8');
    const reader = new LineReader();
    const send = (cmd: string, args: Record<string, string | number | boolean> = {}, status = '') => {
      if (this.silent || socket.destroyed) return;
      const line = formatLine(cmd, args);
      socket.write(status ? line.replace(cmd, `${cmd} ${status}`) : line);
    };
    send('BEGIN', { CompanionVersion: this.opts.companionVersion ?? '4.1.0-mock', ApiVersion: this.opts.apiVersion ?? '1.16.0' });
    if (this.opts.png !== false) send('CAPS', { SUBSCRIPTIONS: false, NONSQUARE: true, BITMAP_FORMATS: 'rgb,png,webp' });

    socket.on('data', (chunk: string) => {
      let lines: string[];
      try {
        lines = reader.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const line of lines) {
        const m = parseLine(line);
        if (!m) continue;
        if (m.command !== 'PING' && m.command !== 'PONG') this.received.push(line);
        if (this.silent) continue;
        const id = typeof m.params.DEVICEID === 'string' ? m.params.DEVICEID : '';
        switch (m.command) {
          case 'PING':
            socket.write(line.replace(/^PING/, 'PONG') + '\n');
            break;
          case 'ADD-DEVICE': {
            if (this.opts.refuse?.includes(id) || (this.devices.has(id) && this.devices.get(id)!.socket !== socket)) {
              send('ADD-DEVICE', { DEVICEID: id, MESSAGE: 'Device exists elsewhere' }, 'ERROR');
              break;
            }
            const total = Number(m.params.KEYS_TOTAL ?? 32);
            const columns = Number(m.params.KEYS_PER_ROW ?? 8);
            const bitmap = m.params.BITMAPS === undefined ? 0 : Number(m.params.BITMAPS) >= 5 ? Number(m.params.BITMAPS) : 72;
            const d: Device = {
              id,
              socket,
              columns,
              rows: Math.ceil(total / columns),
              bitmap,
              png: m.params.BITMAP_FORMAT === 'png' && this.opts.png !== false,
              text: truthy(m.params.TEXT),
              colors: m.params.COLORS !== undefined && m.params.COLORS !== 'false',
              latched: new Set(),
              held: new Set()
            };
            this.devices.set(id, d);
            send('ADD-DEVICE', { DEVICEID: id }, 'OK');
            for (let k = 0; k < total; k++) this.draw(d, k, send);
            break;
          }
          case 'REMOVE-DEVICE':
            if (this.devices.get(id)?.socket === socket) this.devices.delete(id);
            send('REMOVE-DEVICE', { DEVICEID: id }, 'OK');
            break;
          case 'KEY-PRESS': {
            const d = this.devices.get(id);
            const key = Number(m.params.KEY);
            if (!d || d.socket !== socket) {
              send('KEY-PRESS', { DEVICEID: id, MESSAGE: 'Device not found' }, 'ERROR');
              break;
            }
            const pressed = truthy(m.params.PRESSED);
            this.presses.push({ device: id, key, pressed });
            const [, , latches] = button(id, key);
            if (pressed) {
              d.held.add(key);
              if (latches) d.latched.has(key) ? d.latched.delete(key) : d.latched.add(key);
            } else {
              d.held.delete(key);
            }
            send('KEY-PRESS', { DEVICEID: id }, 'OK');
            this.draw(d, key, send);
            break;
          }
        }
      }
    });
    socket.on('close', () => {
      this.sockets.delete(socket);
      for (const [id, d] of this.devices) if (d.socket === socket) this.devices.delete(id);
    });
    socket.on('error', () => {});
  }

  private draw(d: Device, key: number, send: (cmd: string, args: Record<string, string | number | boolean>) => void): void {
    const { label, color } = this.face(d.id, key);
    const args: Record<string, string | number | boolean> = { DEVICEID: d.id, KEY: key, TYPE: 'BUTTON', PRESSED: d.held.has(key) };
    if (d.bitmap) {
      const rgb = render(label, color, d.bitmap);
      args.BITMAP = d.png ? 'data:image/png;base64,' + encodePng(rgb, d.bitmap, d.bitmap).toString('base64') : rgb.toString('base64');
    }
    if (d.colors) {
      args.COLOR = color.toLowerCase();
      args.TEXTCOLOR = '#ffffff';
    }
    if (d.text) args.TEXT = Buffer.from(label.replace(' ', '\n')).toString('base64');
    send('KEY-STATE', args);
  }
}

function button(device: string, key: number): [string, string, boolean] {
  const list = device.endsWith('keys') ? KEYS : TOUCH;
  return list[key % list.length]!;
}

// ---- a 5×7 pixel font, enough for the mock's labels ----------------------------------------------

const GLYPHS: Record<string, string> = {
  A: '0111010001100011111110001100011000110001', B: '1111010001100011111010001100011000111110', C: '0111010001100001000010000100001000101110',
  D: '1111010001100011000110001100011000111110', E: '1111110000100001111010000100001000011111', F: '1111110000100001111010000100001000010000',
  G: '0111010001100001011110001100011000101111', H: '1000110001100011111110001100011000110001', I: '0111000100001000010000100001000010001110',
  J: '0011100010000100001000010100101001001100', K: '1000110010101001100010100100101000110001', L: '1000010000100001000010000100001000011111',
  M: '1000111011101011010110001100011000110001', N: '1000110001110011010110011100011000110001', O: '0111010001100011000110001100011000101110',
  P: '1111010001100011111010000100001000010000', Q: '0111010001100011000110101100101001001101', R: '1111010001100011111010100100101000110001',
  S: '0111110000100000111000001000010000111110', T: '1111100100001000010000100001000010000100', U: '1000110001100011000110001100011000101110',
  V: '1000110001100011000110001010100101000100', W: '1000110001100011010110101101011010101010', X: '1000110001010100010001010100011000110001',
  Y: '1000110001010100010000100001000010000100', Z: '1111100001000100010001000100001000011111', '0': '0111010001100111010111001100011000101110',
  '1': '0010001100001000010000100001000010001110', '2': '0111010001000010001000100010001000011111', '3': '1111100010001000001000001000011000101110',
  '4': '0001000110010101001011111000100001000010', '5': '1111110000111100000100001000011000101110', '6': '0011001000100001111010001100011000101110',
  '7': '1111100001000100010001000010000100001000', '8': '0111010001100010111010001100011000101110', '9': '0111010001100010111100001000010001001100',
  '-': '0000000000000001111100000000000000000000', ':': '0000000100001000000000000001000010000000', ' ': '0'.repeat(40)
};

function hex(c: string): [number, number, number] {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** A size×size RGB bitmap: the colour, and the label in white, one word per line. */
export function render(label: string, color: string, size: number): Buffer {
  const rgb = Buffer.alloc(size * size * 3);
  const [r, g, b] = hex(color);
  for (let i = 0; i < size * size; i++) rgb.set([r, g, b], i * 3);
  const lines = label.toUpperCase().split(' ');
  const widest = Math.max(...lines.map((l) => l.length));
  const scale = Math.max(1, Math.min(Math.floor((size * 0.84) / (widest * 6)), Math.floor((size * 0.7) / (lines.length * 9))));
  const top = Math.floor((size - (lines.length * 9 - 2) * scale) / 2);
  lines.forEach((line, row) => {
    const left = Math.floor((size - (line.length * 6 - 1) * scale) / 2);
    [...line].forEach((ch, col) => {
      const bits = GLYPHS[ch] ?? GLYPHS[' ']!;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 5; x++) {
          if (bits[y * 5 + x] !== '1') continue;
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
              const px = left + (col * 6 + x) * scale + dx;
              const py = top + (row * 9 + y) * scale + dy;
              if (px >= 0 && py >= 0 && px < size && py < size) rgb.set([255, 255, 255], (py * size + px) * 3);
            }
          }
        }
      }
    });
  });
  return rgb;
}
