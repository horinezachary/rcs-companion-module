// A Companion Satellite connection: registers this panel's surfaces with Companion and mirrors what
// Companion draws on them.
//
// Companion is the source of truth for every button. Connecting registers the surfaces (ADD-DEVICE),
// which only tells Companion they exist; Companion then sends the faces. Nothing that presses a
// button goes out until the operator touches a key: there is no replay of presses after a reconnect.
// PING is the only thing sent on a timer.

import { EventEmitter } from 'node:events';
import net from 'node:net';
import { bitmapToPng } from './png.js';
import { DEFAULT_PORT, formatLine, hexColor, LineReader, parseLine, versionOf, type KeyState, type Message } from './protocol.js';

export type Connection = 'connected' | 'connecting' | 'disconnected';

export interface SurfaceSpec {
  /** DEVICEID: stable, so Companion keeps this surface's page and settings across restarts. */
  id: string;
  name: string;
  columns: number;
  rows: number;
  /** Bitmap edge in pixels. */
  bitmap: number;
}

export interface Surface {
  spec: SurfaceSpec;
  registered: boolean;
  error: string;
  keys: (KeyState | undefined)[];
}

export interface ClientOptions {
  port?: number;
  retryMs?: number;
  retryMaxMs?: number;
  pingMs?: number;
  /** No data for this long (pings included) and the connection is dropped. */
  timeoutMs?: number;
}

export interface SatelliteClient {
  on(event: 'status', fn: (connection: Connection, text: string) => void): this;
  /** A surface was registered, refused, cleared or lost. */
  on(event: 'surface', fn: (id: string) => void): this;
  on(event: 'key', fn: (id: string, index: number) => void): this;
  on(event: 'refused', fn: (text: string) => void): this;
}

export class SatelliteClient extends EventEmitter {
  connection: Connection = 'disconnected';
  statusText = '';
  companionVersion = '';
  apiVersion = '';
  readonly surfaces = new Map<string, Surface>();
  readonly port: number;

  private socket: net.Socket | null = null;
  private reader = new LineReader();
  private begun = false;
  private png = false;
  private stopped = true;
  private retryTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private aliveTimer: NodeJS.Timeout | null = null;
  private capsTimer: NodeJS.Timeout | null = null;
  private retryDelay: number;
  private readonly retryMs: number;
  private readonly retryMaxMs: number;
  private readonly pingMs: number;
  private readonly timeoutMs: number;

  constructor(readonly host: string, specs: SurfaceSpec[], opts: ClientOptions = {}) {
    super();
    this.port = opts.port ?? DEFAULT_PORT;
    this.retryMs = opts.retryMs ?? 1000;
    this.retryMaxMs = opts.retryMaxMs ?? 10_000;
    this.pingMs = opts.pingMs ?? 2000;
    this.timeoutMs = opts.timeoutMs ?? 6000;
    this.retryDelay = this.retryMs;
    for (const spec of specs) this.surfaces.set(spec.id, blank(spec));
  }

  get address(): string {
    return this.port === DEFAULT_PORT ? this.host : `${this.host}:${this.port}`;
  }

  get ready(): boolean {
    return this.begun;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const socket = this.socket;
    if (socket && this.begun) {
      // Take the surfaces out of Companion politely, then hang up.
      for (const s of this.surfaces.values()) if (s.registered) this.write('REMOVE-DEVICE', { DEVICEID: s.spec.id });
      this.socket = null;
      socket.end();
      setTimeout(() => socket.destroy(), 500).unref();
    }
    this.teardown();
    this.setStatus('disconnected', 'Stopped');
  }

  /** Changes the surfaces: a changed or removed one is taken out of Companion, a new one is added. */
  setSurfaces(specs: SurfaceSpec[]): void {
    const next = new Map(specs.map((s) => [s.id, s]));
    for (const [id, s] of [...this.surfaces]) {
      const spec = next.get(id);
      if (spec && same(spec, s.spec)) continue;
      if (s.registered) this.write('REMOVE-DEVICE', { DEVICEID: id });
      this.surfaces.delete(id);
      this.emit('surface', id);
    }
    for (const spec of specs) {
      if (this.surfaces.has(spec.id)) continue;
      this.surfaces.set(spec.id, blank(spec));
      if (this.begun) this.register(spec);
    }
  }

  /** An operator press or release. False when that surface is not live in Companion. */
  press(id: string, key: number, pressed: boolean): boolean {
    const s = this.surfaces.get(id);
    if (!this.socket || !s?.registered || !Number.isInteger(key) || key < 0 || key >= s.spec.columns * s.spec.rows) return false;
    this.write('KEY-PRESS', { DEVICEID: id, KEY: key, PRESSED: pressed });
    return true;
  }

  private connect(): void {
    this.reader = new LineReader();
    this.begun = false;
    this.png = false;
    this.setStatus('connecting', `Connecting to ${this.address}`);
    const socket = net.createConnection({ host: this.host, port: this.port });
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    let why = '';
    socket.on('connect', () => {
      this.setStatus('connecting', `Waiting for Companion at ${this.address}`);
      this.alive();
    });
    socket.on('data', (chunk: string) => {
      this.alive();
      let lines: string[];
      try {
        lines = this.reader.push(chunk);
      } catch {
        why = 'bad data';
        socket.destroy();
        return;
      }
      for (const line of lines) {
        const m = parseLine(line);
        if (m) this.onMessage(m);
        if (this.socket !== socket) return;
      }
    });
    socket.on('error', (e) => {
      why = e.message;
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.teardown();
      if (this.stopped) return;
      this.setStatus('disconnected', `${this.address}: ${friendly(why)} · retrying`);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (!this.stopped) this.connect();
      }, this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, this.retryMaxMs);
    });
  }

  private onMessage(m: Message): void {
    const id = typeof m.params.DEVICEID === 'string' ? m.params.DEVICEID : '';
    const surface = this.surfaces.get(id);
    switch (m.command) {
      case 'BEGIN': {
        this.companionVersion = String(m.params.CompanionVersion ?? '');
        this.apiVersion = String(m.params.ApiVersion ?? '');
        if (versionOf(m.params.ApiVersion)[0] !== 1) {
          this.socket?.destroy(new Error(`Companion speaks Satellite API ${this.apiVersion || '?'}, this module needs 1.x`));
          return;
        }
        this.begun = true;
        this.retryDelay = this.retryMs;
        this.schedulePing();
        // Companion 3.4 and later follow BEGIN with CAPS; older ones never send it.
        this.capsTimer = setTimeout(() => this.registerAll(), 300);
        return;
      }
      case 'CAPS': {
        const formats = typeof m.params.BITMAP_FORMATS === 'string' ? m.params.BITMAP_FORMATS.split(',') : [];
        this.png = formats.includes('png');
        this.registerAll();
        return;
      }
      case 'PING':
        this.write('PONG', {}, rest(m));
        return;
      case 'PONG':
        return;
      case 'ADD-DEVICE':
        if (!surface) return;
        surface.registered = m.status === 'OK';
        surface.error = m.status === 'ERROR' ? String(m.params.MESSAGE ?? 'refused') : '';
        this.emit('surface', id);
        this.setStatus('connected', this.describe());
        return;
      case 'KEY-STATE': {
        if (!surface) return;
        const key = Number(m.params.KEY);
        if (!Number.isInteger(key) || key < 0 || key >= surface.keys.length) return;
        const p = m.params;
        const text = typeof p.TEXT === 'string' ? Buffer.from(p.TEXT, 'base64').toString('utf8') : undefined;
        const image = typeof p.BITMAP === 'string' ? bitmapToPng(p.BITMAP) : undefined;
        const state: KeyState = { pressed: p.PRESSED === true || p.PRESSED === 'true' || p.PRESSED === '1' };
        if (image) state.image = image;
        const color = hexColor(p.COLOR);
        if (color) state.color = color;
        const textColor = hexColor(p.TEXTCOLOR);
        if (textColor) state.textColor = textColor;
        if (text !== undefined) state.text = text;
        surface.keys[key] = state;
        this.emit('key', id, key);
        return;
      }
      case 'KEYS-CLEAR':
        if (!surface) return;
        surface.keys = surface.keys.map(() => undefined);
        this.emit('surface', id);
        return;
      case 'KEY-PRESS':
        if (m.status === 'ERROR') this.emit('refused', String(m.params.MESSAGE ?? 'Companion refused the press'));
        return;
      case 'ERROR':
        if (surface && !surface.registered) {
          surface.error = String(m.params.MESSAGE ?? 'refused');
          this.emit('surface', id);
        }
        return;
      default:
        // BRIGHTNESS (the system owns it), LOCKED-STATE (not asked for), VARIABLE-VALUE and the rest.
        return;
    }
  }

  private registerAll(): void {
    if (this.capsTimer) clearTimeout(this.capsTimer);
    this.capsTimer = null;
    if (!this.begun) return;
    for (const s of this.surfaces.values()) if (!s.registered && !s.error) this.register(s.spec);
    this.setStatus('connected', this.describe());
  }

  private register(spec: SurfaceSpec): void {
    // Companion before 1.5 ignores the size and draws 72 px; the PNG is scaled to fit either way.
    const args: Record<string, string | number | boolean> = {
      DEVICEID: spec.id,
      PRODUCT_NAME: spec.name,
      KEYS_TOTAL: spec.columns * spec.rows,
      KEYS_PER_ROW: spec.columns,
      BITMAPS: spec.bitmap,
      COLORS: 'hex',
      TEXT: true,
      BRIGHTNESS: false
    };
    if (this.png) args.BITMAP_FORMAT = 'png';
    this.write('ADD-DEVICE', args);
  }

  private write(command: string, args: Record<string, string | number | boolean>, raw = ''): void {
    if (!this.socket || this.socket.destroyed) return;
    const line = formatLine(command, args);
    this.socket.write(raw ? line.slice(0, -1) + ' ' + raw + '\n' : line);
  }

  private teardown(): void {
    for (const t of [this.pingTimer, this.aliveTimer, this.capsTimer]) if (t) clearTimeout(t);
    this.pingTimer = this.aliveTimer = this.capsTimer = null;
    const s = this.socket;
    this.socket = null;
    s?.destroy();
    this.begun = false;
    for (const [id, surface] of this.surfaces) {
      const had = surface.registered || surface.error || surface.keys.some(Boolean);
      surface.registered = false;
      surface.error = '';
      surface.keys = surface.keys.map(() => undefined);
      if (had) this.emit('surface', id);
    }
  }

  private alive(): void {
    if (this.aliveTimer) clearTimeout(this.aliveTimer);
    const socket = this.socket;
    this.aliveTimer = setTimeout(() => {
      if (this.socket !== socket) return;
      socket?.destroy(new Error('no answer'));
    }, this.timeoutMs);
  }

  private schedulePing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => this.write('PING', {}, 'rcs'), this.pingMs);
  }

  private describe(): string {
    const list = [...this.surfaces.values()];
    const bad = list.find((s) => s.error);
    if (bad) return `Companion refused ${bad.spec.name}: ${bad.error}`;
    const v = this.companionVersion ? `Companion ${this.companionVersion}` : 'Companion';
    return `${v} · ${this.address}`;
  }

  private setStatus(connection: Connection, text: string): void {
    if (connection === this.connection && text === this.statusText) return;
    this.connection = connection;
    this.statusText = text;
    this.emit('status', connection, text);
  }
}

function blank(spec: SurfaceSpec): Surface {
  return { spec, registered: false, error: '', keys: new Array(spec.columns * spec.rows).fill(undefined) };
}

function same(a: SurfaceSpec, b: SurfaceSpec): boolean {
  return a.id === b.id && a.name === b.name && a.columns === b.columns && a.rows === b.rows && a.bitmap === b.bitmap;
}

/** The PING payload, echoed back verbatim as Companion does. */
function rest(m: Message): string {
  return Object.entries(m.params)
    .map(([k, v]) => (v === true ? k : `${k}=${v}`))
    .join(' ');
}

function friendly(message: string): string {
  if (/ECONNREFUSED/.test(message)) return 'refused';
  if (/EHOSTUNREACH|ENETUNREACH/.test(message)) return 'unreachable';
  if (/ETIMEDOUT|no answer/.test(message)) return 'no answer';
  if (/ENOTFOUND|EAI_AGAIN/.test(message)) return 'address not found';
  if (/Satellite API/.test(message)) return message;
  return 'connection lost';
}
