// The Companion Satellite API: one command per line, `COMMAND [OK|ERROR] KEY=value KEY="quoted value"`.
// A backslash escapes the next character inside a value, and a bare word is a flag (true).
// Reference: satellite-protocol/lib/codec.ts in bitfocus/companion.

export const DEFAULT_PORT = 16622;

/** The API version this module was written against. Companion speaks any 1.x to it. */
export const API_VERSION = '1.7.0';

export type Params = Record<string, string | true>;

export interface Message {
  command: string;
  /** OK or ERROR, for replies such as `ADD-DEVICE OK DEVICEID=…`. */
  status: 'OK' | 'ERROR' | null;
  params: Params;
}

/** A line can carry a large bitmap; anything past this is a broken peer. */
export const MAX_LINE = 2 * 1024 * 1024;

export function parseParams(body: string): Params {
  const fragments = [''];
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === '\\') {
      fragments[fragments.length - 1] += body[++i] ?? '';
    } else if (c === '"') {
      quoted = !quoted;
    } else if (c === ' ' && !quoted) {
      fragments.push('');
    } else {
      fragments[fragments.length - 1] += c;
    }
  }
  const out: Params = Object.create(null);
  for (const f of fragments) {
    if (!f) continue;
    const eq = f.indexOf('=');
    if (eq === -1) out[f] = true;
    else if (eq > 0) out[f.slice(0, eq)] = f.slice(eq + 1);
  }
  return out;
}

export function parseLine(line: string): Message | null {
  const text = line.trim();
  if (!text) return null;
  const sp = text.indexOf(' ');
  const command = (sp === -1 ? text : text.slice(0, sp)).toUpperCase();
  let body = sp === -1 ? '' : text.slice(sp + 1);
  let status: Message['status'] = null;
  const m = /^(OK|ERROR)(\s|$)/.exec(body);
  if (m) {
    status = m[1] as 'OK' | 'ERROR';
    body = body.slice(m[0].length);
  }
  return { command, status, params: parseParams(body) };
}

function quote(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error('A Satellite value cannot hold a line break');
  return `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

export function formatLine(command: string, args: Record<string, string | number | boolean> = {}): string {
  const parts = [command];
  for (const [k, v] of Object.entries(args)) {
    if (!/^[A-Za-z0-9_-]+$/.test(k)) throw new Error(`Bad Satellite parameter ${k}`);
    parts.push(`${k}=${typeof v === 'boolean' ? (v ? '1' : '0') : typeof v === 'number' ? String(v) : quote(v)}`);
  }
  return parts.join(' ') + '\n';
}

/** Splits a TCP stream into lines. Throws when a line grows past MAX_LINE. */
export class LineReader {
  private buf = '';

  push(chunk: string): string[] {
    this.buf += chunk;
    const lines: string[] = [];
    let at = 0;
    let nl: number;
    while ((nl = this.buf.indexOf('\n', at)) !== -1) {
      const line = this.buf.slice(at, nl);
      lines.push(line.endsWith('\r') ? line.slice(0, -1) : line);
      at = nl + 1;
    }
    this.buf = this.buf.slice(at);
    if (this.buf.length > MAX_LINE) {
      this.buf = '';
      throw new Error('line too long');
    }
    return lines;
  }
}

export function truthy(v: string | true | undefined): boolean {
  if (v === true) return true;
  if (v === undefined) return false;
  const s = v.toLowerCase();
  return s === 'true' || s === 'yes' || Number(s) >= 1;
}

/** Major.minor of a version string, 0.0 when it cannot be read. */
export function versionOf(v: string | true | undefined): [number, number] {
  const m = typeof v === 'string' ? /^(\d+)\.(\d+)/.exec(v) : null;
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
}

/** What Companion draws on one key, as the module keeps it. */
export interface KeyState {
  /** PNG, base64, no data: prefix. */
  image?: string;
  /** #RRGGBB */
  color?: string;
  textColor?: string;
  text?: string;
  pressed: boolean;
}

export function hexColor(v: string | true | undefined): string | undefined {
  if (typeof v !== 'string') return undefined;
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toUpperCase();
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/i.exec(v);
  if (!m) return undefined;
  return '#' + m.slice(1, 4).map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('').toUpperCase();
}
