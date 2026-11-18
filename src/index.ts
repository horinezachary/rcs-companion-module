// Companion: the touch screen and the Stream Deck become Bitfocus Companion surfaces.
//
// Two ways to run, picked on first start (and changed in Setup):
//   satellite  connect to a Companion already running on another computer
//   local      run Companion itself on this panel, then connect to it on 127.0.0.1
// Either way the module speaks the Companion Satellite API itself and registers two surfaces: the
// Stream Deck's keys, at the deck's own size (5×3, an XL 8×4, a Stream Deck + XL 9×4; re-registered when
// another deck is plugged in), and a touch grid (12×3 by default). Companion is the source of truth for every button:
// faces come from Companion and are never saved. Config holds only the choice, the address and the
// grid size. Starting, restoring and reconnecting only register the surfaces; a button press goes to
// Companion only when someone touches a key.

import os from 'node:os';
import path from 'node:path';
import { defineModule, type Ctx, type KeySetParams } from '@rcs/module-sdk';
import { SatelliteClient, type SurfaceSpec } from './client.js';
import { DEFAULT_PORT, type KeyState } from './protocol.js';
import { rm } from 'node:fs/promises';
import { ADMIN_PORT, CompanionRunner, downloadFor, MODULE_BUNDLE_URL } from './runner.js';
import { download, downloadsDir, installedVersion, installTarball, isNewer, latestPackage, openInstaller, packageTarget, type Package } from './updater.js';

export type Mode = '' | 'satellite' | 'local';
export type GridId = '12x3' | '8x2' | '6x2' | '4x1' | 'keys';

export interface Config {
  mode: Mode;
  /** Companion's address, for satellite mode. */
  host: string;
  port: number;
  grid: GridId;
  /** Where Companion is installed, for local mode. Empty: look in the usual places. */
  companionDir: string;
}

// Nothing of the module's own needs keeping between starts beyond config.
export type State = Record<string, never>;

type C = Ctx<State, Config>;
export type View = 'buttons' | 'status' | 'setup';

/** Touch grids. The bitmap size is what Companion draws at; the panel scales it to the tile. */
export const GRIDS: Record<GridId, { columns: number; rows: number; bitmap: number; label: string }> = {
  '12x3': { columns: 12, rows: 3, bitmap: 112, label: '12×3' },
  '8x2': { columns: 8, rows: 2, bitmap: 160, label: '8×2' },
  '6x2': { columns: 6, rows: 2, bitmap: 168, label: '6×2' },
  '4x1': { columns: 4, rows: 1, bitmap: 288, label: '4×1' },
  keys: { columns: 11, rows: 2, bitmap: 112, label: 'Key size' }
};

/** Keys on the choice screen, as in the mockup: key 6 runs Companion here, key 8 connects to one. */
export const KEY = { RUN_LOCAL: 5, RUN_SATELLITE: 7, BACK: 13, STATUS: 7 } as const;

export interface Grid {
  columns: number;
  rows: number;
}

/**
 * The deck's grid. Read from ctx.host, not ctx.deck: a unit runs modules with its own controller's
 * SDK, and one before 0.21.0 has no ctx.deck and reports no columns or rows (5 × 3).
 */
export function grid(ctx: { host: { deck: { columns?: number; rows?: number } } }): Grid {
  return { columns: ctx.host?.deck?.columns ?? 5, rows: ctx.host?.deck?.rows ?? 3 };
}

/** A KEY (numbered on a 5 × 3 deck) at the same column and row of a larger deck. */
function at(g: Grid, key: number): number {
  return Math.floor(key / 5) * g.columns + (key % 5);
}
/** ui.send drops anything over 64 KB, so tiles go out in batches under this. */
const UI_BATCH_BYTES = 56 * 1024;

const ACCENT = '#F5A524';
const ON_ACCENT = '#16181C';
const SURFACE = '#1B1E23';
const DANGER = '#3A1E1C';

interface Runtime {
  ctx: C;
  client: SatelliteClient | null;
  runner: CompanionRunner | null;
  view: View;
  /** How many hands are on each key, per surface:key, so two browsers pressing make one press. */
  held: Map<string, number>;
  /** What each UI client is holding, to let go when it disconnects. */
  clientHeld: Map<string, Set<string>>;
  deckHeld: Set<number>;
  dirty: { deck: Set<number>; touch: Set<number>; timer: NodeJS.Timeout | null };
  update: UpdateState;
}
let rt: Runtime | null = null;

interface UpdateState {
  checking: boolean;
  checkedAt: number | null;
  latest: Package | null;
  /** idle, downloading, installing, done or error; only ever moved on by someone pressing Update. */
  phase: 'idle' | 'downloading' | 'installing' | 'done' | 'error';
  done: number;
  total: number;
  message: string;
}

const newUpdate = (): UpdateState => ({ checking: false, checkedAt: null, latest: null, phase: 'idle', done: 0, total: 0, message: '' });

/** Where updates come from; tests point it at a fake Bitfocus. */
export const updateSource: { api?: string; fetchImpl?: typeof fetch; downloads?: string; platform?: NodeJS.Platform; arch?: string; open?: (file: string) => void } = {};

const ADDRESS_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

export function validAddress(a: unknown): a is string {
  return typeof a === 'string' && (a === '' || ADDRESS_RE.test(a));
}

export function cfg(ctx: C): Config {
  const c = ctx.config ?? ({} as Config);
  return {
    mode: c.mode === 'satellite' || c.mode === 'local' ? c.mode : '',
    host: c.host ?? '',
    port: c.port ?? DEFAULT_PORT,
    grid: c.grid && c.grid in GRIDS ? c.grid : '12x3',
    companionDir: c.companionDir ?? ''
  };
}

export function phase(c: Config): 'choose' | 'host' | 'running' {
  if (!c.mode) return 'choose';
  if (c.mode === 'satellite' && !c.host) return 'host';
  return 'running';
}

function panelName(): string {
  return os.hostname().replace(/[^A-Za-z0-9-]/g, '').slice(0, 40) || 'rcs';
}

export function surfaceIds(): { keys: string; touch: string } {
  const base = 'rcs-' + panelName().toLowerCase();
  return { keys: `${base}-keys`, touch: `${base}-touch` };
}

function specs(ctx: C): SurfaceSpec[] {
  const ids = surfaceIds();
  const g = GRIDS[cfg(ctx).grid];
  return [
    { id: ids.keys, name: `${panelName()} keys`, ...grid(ctx), bitmap: ctx.host?.deck?.keySize ?? 72 },
    { id: ids.touch, name: `${panelName()} touch`, columns: g.columns, rows: g.rows, bitmap: g.bitmap }
  ];
}

function selfAddress(): string {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return '127.0.0.1';
}

function short(s: string | undefined, n: number): string {
  const chars = [...(s ?? '')];
  return chars.length > n ? chars.slice(0, n).join('') : chars.join('');
}

// ---- running Companion and the connection ---------------------------------------------------------

/** Brings the runner and the connection in line with config. Registers surfaces; never presses. */
function apply(ctx: C, force = false): void {
  if (!rt) return;
  const c = cfg(ctx);
  const p = phase(c);

  if (p === 'running' && c.mode === 'local') {
    if (!rt.runner || rt.runner.wantedDir !== c.companionDir) {
      void rt.runner?.stop();
      const runner = new CompanionRunner({ dir: c.companionDir, configDir: path.join(ctx.dataDir, 'companion') });
      rt.runner = runner;
      runner.on('change', () => {
        if (rt?.runner !== runner) return;
        report(ctx);
        void draw(ctx);
      });
      runner.start();
    }
  } else if (rt.runner) {
    void rt.runner.stop();
    rt.runner = null;
  }

  const target = p !== 'running' ? null : c.mode === 'local' ? { host: '127.0.0.1', port: DEFAULT_PORT } : { host: c.host, port: c.port };
  const old = rt.client;
  if (old && target && !force && old.host === target.host && old.port === target.port) {
    old.setSurfaces(specs(ctx));
    return;
  }
  if (old) {
    old.removeAllListeners();
    old.stop();
    rt.client = null;
    releaseAll();
  }
  if (!target) {
    report(ctx);
    return;
  }
  const client = new SatelliteClient(target.host, specs(ctx), { port: target.port, retryMaxMs: c.mode === 'local' ? 3000 : 10_000 });
  rt.client = client;
  const ids = surfaceIds();
  client.on('status', () => {
    if (rt?.client !== client) return;
    report(ctx);
    void draw(ctx);
  });
  client.on('surface', (id) => {
    if (rt?.client !== client) return;
    // Registered, refused, cleared or lost: what was held there is gone with it.
    for (const k of [...rt.held.keys()]) if (k.startsWith(id + ':')) rt.held.delete(k);
    if (id === ids.keys) rt.deckHeld.clear();
    markAll(id === ids.keys ? 'deck' : 'touch');
    report(ctx);
    void draw(ctx);
  });
  client.on('key', (id, index) => {
    if (rt?.client !== client) return;
    mark(id === ids.keys ? 'deck' : 'touch', index);
  });
  client.on('refused', (text) => void ctx.log('warning', `Companion: ${text}`));
  client.start();
  report(ctx);
}

/** The module status the system shows: the connection, or why there is none. */
function report(ctx: C): void {
  const c = cfg(ctx);
  const p = phase(c);
  if (p === 'choose') return void ctx.status('disconnected', 'Choose how to run Companion');
  if (p === 'host') return void ctx.status('disconnected', "Type Companion's address");
  const runner = rt?.runner;
  const client = rt?.client;
  if (!client) return void ctx.status('disconnected');
  // A Companion someone started by hand on this panel still counts.
  if (client.connection === 'connected') return void ctx.status('connected', client.statusText);
  if (runner?.state === 'external') return void ctx.status('connecting', 'Companion is already running on this computer; connecting to it');
  if (runner?.state === 'missing') return void ctx.status('disconnected', runner.wantedDir ? `Companion is not in ${runner.wantedDir}` : 'Companion is not installed on this panel');
  if (runner && runner.state !== 'running') {
    return void ctx.status('connecting', runner.state === 'restarting' ? `Companion ${runner.lastExit}; restarting` : 'Starting Companion');
  }
  void ctx.status(client.connection, client.statusText);
}

// ---- presses: the only thing that changes anything in Companion -------------------------------------

function press(surface: string, key: number, down: boolean): void {
  if (!rt?.client) return;
  const id = `${surface}:${key}`;
  const n = rt.held.get(id) ?? 0;
  if (down) {
    if (n === 0 && !rt.client.press(surface, key, true)) return;
    rt.held.set(id, n + 1);
  } else {
    if (n === 0) return; // a release with no press to match, such as one from before a reconnect
    if (n === 1) {
      rt.held.delete(id);
      rt.client.press(surface, key, false);
    } else {
      rt.held.set(id, n - 1);
    }
  }
}

/** A press from a screen: the panel's touch grid, or either surface in the web view. */
function touch(clientId: string, which: Which, key: number, down: boolean): void {
  if (!rt) return;
  const touchId = surfaceIds()[which === 'keys' ? 'keys' : 'touch'];
  const id = `${touchId}:${key}`;
  let mine = rt.clientHeld.get(clientId);
  if (down) {
    if (mine?.has(id)) return;
    const before = rt.held.get(id) ?? 0;
    press(touchId, key, true);
    if ((rt.held.get(id) ?? 0) === before) return;
    if (!mine) rt.clientHeld.set(clientId, (mine = new Set()));
    mine.add(id);
  } else if (mine?.delete(id)) {
    press(touchId, key, false);
  }
}

function releaseClient(clientId: string): void {
  const mine = rt?.clientHeld.get(clientId);
  if (!rt || !mine) return;
  rt.clientHeld.delete(clientId);
  for (const id of mine) {
    const i = id.lastIndexOf(':');
    press(id.slice(0, i), Number(id.slice(i + 1)), false);
  }
}

function releaseDeck(): void {
  if (!rt) return;
  const keys = surfaceIds().keys;
  for (const k of rt.deckHeld) press(keys, k, false);
  rt.deckHeld.clear();
}

function releaseAll(): void {
  if (!rt) return;
  rt.held.clear();
  rt.clientHeld.clear();
  rt.deckHeld.clear();
}

// ---- updating Companion: only when someone presses Update and confirms -----------------------------

function updateTarget(): string | null {
  return packageTarget(updateSource.platform, updateSource.arch);
}

/** What the web view shows about updates. */
function updateInfo() {
  const u = rt?.update ?? newUpdate();
  const runner = rt?.runner;
  const installed = installedVersion(runner?.found ?? null) || rt?.client?.companionVersion || '';
  // Linux builds are .tar.gz and are put in place; macOS and Windows get their installer.
  const tarball = !!updateTarget()?.endsWith('tgz');
  let blocked = '';
  if (tarball && runner?.state === 'external') blocked = 'Companion is running outside the module, so it is updated where it was started (on a CompanionPi: sudo companion-update).';
  else if (tarball && !runner?.found) blocked = 'Companion is not installed here yet.';
  return {
    target: updateTarget(),
    installed,
    latest: u.latest ? { version: u.latest.version, published: u.latest.published, file: path.basename(new URL(u.latest.uri).pathname) } : null,
    available: !!u.latest && isNewer(u.latest.version, installed),
    how: tarball ? 'replace' : 'installer',
    blocked,
    checking: u.checking,
    checkedAt: u.checkedAt,
    phase: u.phase,
    done: u.done,
    total: u.total,
    message: u.message
  };
}

function sendUpdate(ctx: C): Promise<void> {
  return ctx.ui.send(snapshot(ctx));
}

async function checkUpdate(ctx: C): Promise<void> {
  const u = rt?.update;
  const target = updateTarget();
  if (!u || u.checking || !target) return;
  u.checking = true;
  await sendUpdate(ctx);
  try {
    u.latest = await latestPackage(target, { api: updateSource.api ?? process.env.RCS_COMPANION_PACKAGES_API, fetchImpl: updateSource.fetchImpl });
    if (u.phase === 'error') u.phase = 'idle';
    if (u.phase === 'idle') u.message = u.latest ? '' : 'Bitfocus lists no Companion build for this computer.';
  } catch (e) {
    if (u.phase === 'idle' || u.phase === 'error') u.message = `Could not check for updates: ${(e as Error).message}`;
  } finally {
    u.checking = false;
    u.checkedAt = Date.now();
  }
  await sendUpdate(ctx);
}

async function installUpdate(ctx: C): Promise<void> {
  const u = rt?.update;
  const runner = rt?.runner;
  if (!u || !u.latest || u.phase === 'downloading' || u.phase === 'installing' || cfg(ctx).mode !== 'local') return;
  const info = updateInfo();
  if (info.blocked) return;
  const pkg = u.latest;
  const file = info.latest!.file;
  const progress = (done: number, total: number) => {
    u.done = done;
    u.total = total;
    void sendUpdate(ctx);
  };
  u.phase = 'downloading';
  u.done = u.total = 0;
  u.message = `Downloading Companion ${pkg.version}`;
  await sendUpdate(ctx);
  try {
    if (info.how === 'replace' && runner?.found) {
      const tgz = path.join(ctx.dataDir, 'updates', file);
      await download(pkg.uri, tgz, progress, updateSource.fetchImpl);
      u.phase = 'installing';
      u.message = `Installing Companion ${pkg.version}`;
      await sendUpdate(ctx);
      const dir = runner.found.dir;
      await runner.stop();
      try {
        await installTarball(tgz, dir);
      } finally {
        await rm(tgz, { force: true });
        // The new build, or the old one if putting the new one in place failed.
        runner.start();
      }
      u.phase = 'done';
      u.message = `Companion ${pkg.version} is installed and starting. The previous build is kept in ${dir}.previous.`;
    } else {
      const dest = path.join(updateSource.downloads ?? downloadsDir(), file);
      await download(pkg.uri, dest, progress, updateSource.fetchImpl);
      (updateSource.open ?? openInstaller)(dest);
      u.phase = 'done';
      u.message = `Saved ${dest} and opened it. Quit Companion, then finish the installer; the module connects again once Companion is back.`;
    }
  } catch (e) {
    u.phase = 'error';
    u.message = `Update failed: ${(e as Error).message}`;
  }
  await draw(ctx);
}

// ---- drawing -------------------------------------------------------------------------------------

function surfaceInfo(id: string) {
  const s = rt?.client?.surfaces.get(id);
  return s ? { registered: s.registered, error: s.error, columns: s.spec.columns, rows: s.spec.rows } : null;
}

export function snapshot(ctx: C) {
  const c = cfg(ctx);
  const client = rt?.client;
  const runner = rt?.runner;
  const ids = surfaceIds();
  const self = selfAddress();
  const companionHost = c.mode === 'local' ? self : c.host;
  return {
    type: 'snapshot',
    phase: phase(c),
    view: rt?.view ?? 'buttons',
    config: c,
    connection: client?.connection ?? 'disconnected',
    statusText: client?.statusText ?? '',
    companion: { version: client?.companionVersion ?? '', api: client?.apiVersion ?? '', address: client?.address ?? '' },
    surfaces: { keys: { id: ids.keys, ...surfaceInfo(ids.keys) }, touch: { id: ids.touch, ...surfaceInfo(ids.touch) } },
    grid: { id: c.grid, ...GRIDS[c.grid] },
    grids: Object.entries(GRIDS).map(([id, g]) => ({ id, label: g.label })),
    runner: runner
      ? { state: runner.state, pid: runner.pid, startedAt: runner.startedAt, restarts: runner.restarts, lastExit: runner.lastExit, dir: runner.dir, found: !!runner.found, wantedDir: runner.wantedDir, searched: runner.searched, configDir: runner.companionConfigDir, external: runner.state === 'external', desktop: runner.found?.kind === 'desktop', tail: runner.tail.slice(-8) }
      : null,
    self,
    manageUrl: companionHost ? `http://${companionHost}:${ADMIN_PORT}` : '',
    // Only a Companion on this computer: one elsewhere is updated on that computer.
    download: c.mode === 'local' ? downloadFor(updateSource.platform, updateSource.arch) : null,
    update: c.mode === 'local' ? updateInfo() : null,
    moduleBundleUrl: MODULE_BUNDLE_URL
  };
}

type Which = 'touch' | 'keys';

/** One button for the UIs. */
function tile(index: number, k: KeyState | undefined) {
  return k ? { i: index, image: k.image, color: k.color, textColor: k.textColor, text: k.text, pressed: k.pressed } : { i: index };
}

/**
 * Sends a surface's buttons in batches that fit a UI message. `all` sends the whole surface,
 * starting fresh. The panel draws the touch grid; the web view draws both.
 */
async function sendTiles(ctx: C, which: Which, indexes: number[] | 'all', clientId?: string): Promise<void> {
  const surface = rt?.client?.surfaces.get(surfaceIds()[which === 'keys' ? 'keys' : 'touch']);
  const g = which === 'keys' ? grid(ctx) : GRIDS[cfg(ctx).grid];
  const all = indexes === 'all';
  const list = all ? [...Array(g.columns * g.rows).keys()] : indexes;
  let batch: ReturnType<typeof tile>[] = [];
  let bytes = 0;
  let first = all;
  const flush = async () => {
    await ctx.ui.send({ type: 'tiles', surface: which, reset: first, columns: g.columns, rows: g.rows, tiles: batch }, clientId);
    first = false;
    batch = [];
    bytes = 0;
  };
  for (const i of list) {
    let t = tile(i, surface?.keys[i]);
    let size = JSON.stringify(t).length;
    if (size > UI_BATCH_BYTES) {
      // Too big to send at all: show Companion's colour and text instead of its picture.
      t = { ...t, image: undefined };
      size = JSON.stringify(t).length;
    }
    if (bytes + size > UI_BATCH_BYTES) await flush();
    batch.push(t);
    bytes += size;
  }
  if (batch.length || first) await flush();
}

function blank(index: number): KeySetParams {
  return { index };
}

/** The deck's keys: Companion's faces while the keys surface is live, otherwise the module's own. */
function keyFaces(ctx: C): KeySetParams[] {
  const c = cfg(ctx);
  const p = phase(c);
  const g = grid(ctx);
  const faces = [...Array(g.columns * g.rows).keys()].map(blank);
  const put = (key: number, face: Omit<KeySetParams, 'index'>) => (faces[at(g, key)] = { index: at(g, key), ...face });
  if (p === 'choose') {
    put(KEY.RUN_LOCAL, { label: 'RUN HERE', sublabel: 'Companion', background: ACCENT, color: ON_ACCENT });
    put(KEY.RUN_SATELLITE, { label: 'CONNECT', sublabel: 'Satellite', background: SURFACE });
    return faces;
  }
  if (p === 'host') {
    put(KEY.BACK, { label: 'BACK', background: SURFACE });
    return faces;
  }
  const s = rt?.client?.surfaces.get(surfaceIds().keys);
  if (!s?.registered) {
    const runner = rt?.runner;
    const label = runner?.state === 'missing' ? 'NOT FOUND' : rt?.client?.connection === 'connecting' ? 'CONNECTING' : 'OFFLINE';
    const sub = runner ? 'Companion' : short(c.host, 12);
    put(KEY.STATUS, { label, sublabel: s?.error ? 'refused' : sub, background: DANGER });
    return faces;
  }
  return s.keys.map((k, index) => deckFace(index, k));
}

function deckFace(index: number, k: KeyState | undefined): KeySetParams {
  if (!k) return { index };
  if (k.image) return { index, image: k.image };
  const lines = (k.text ?? '').split(/\r?\n/).filter(Boolean);
  const face: KeySetParams = { index };
  if (lines[0]) face.label = short(lines[0], 10);
  if (lines[1]) face.sublabel = short(lines.slice(1).join(' '), 12);
  if (k.color) face.background = k.color;
  if (k.textColor) face.color = k.textColor;
  return face;
}

function mark(which: 'deck' | 'touch', index: number): void {
  if (!rt) return;
  rt.dirty[which].add(index);
  schedule();
}

function markAll(which: 'deck' | 'touch'): void {
  if (!rt) return;
  const n = which === 'deck' ? grid(rt.ctx).columns * grid(rt.ctx).rows : GRIDS[cfg(rt.ctx).grid].columns * GRIDS[cfg(rt.ctx).grid].rows;
  for (let i = 0; i < n; i++) rt.dirty[which].add(i);
  schedule();
}

/** Companion redraws a page as a burst of KEY-STATEs: gather them for a moment, then draw once. */
function schedule(): void {
  if (!rt || rt.dirty.timer) return;
  const r = rt;
  r.dirty.timer = setTimeout(() => {
    r.dirty.timer = null;
    if (rt !== r) return;
    void flushDirty(r.ctx);
  }, 25);
}

async function flushDirty(ctx: C): Promise<void> {
  if (!rt) return;
  const deck = [...rt.dirty.deck];
  const tiles = [...rt.dirty.touch];
  rt.dirty.deck.clear();
  rt.dirty.touch.clear();
  if (deck.length) {
    const faces = keyFaces(ctx);
    await ctx.keys.setMany(deck.filter((i) => i < faces.length).map((i) => faces[i]!));
    await sendTiles(ctx, 'keys', deck.sort((a, b) => a - b));
  }
  if (tiles.length) await sendTiles(ctx, 'touch', tiles.sort((a, b) => a - b));
}

export async function draw(ctx: C, clientId?: string): Promise<void> {
  if (!clientId) await ctx.keys.setMany(keyFaces(ctx));
  await ctx.ui.send(snapshot(ctx), clientId);
  if (phase(cfg(ctx)) === 'running') {
    await sendTiles(ctx, 'touch', 'all', clientId);
    await sendTiles(ctx, 'keys', 'all', clientId);
  }
}

function strip(ctx: C): Promise<void> {
  if (phase(cfg(ctx)) !== 'running') return ctx.strip.set([]);
  return ctx.strip.set(
    [
      { id: 'buttons', label: 'Buttons', icon: 'assets/buttons.svg' },
      { id: 'status', label: 'Status', icon: 'assets/status.svg' },
      { id: 'setup', label: 'Setup', icon: 'assets/setup.svg' }
    ],
    rt?.view ?? 'buttons'
  );
}

/** Changes the panel's page from inside the module (a button in its UI), moving the strip highlight too. */
async function showView(ctx: C, view: View): Promise<void> {
  if (!rt) return;
  rt.view = view;
  // strip.select arrived with host 0.8.0; an older host keeps the highlight where it was.
  if (phase(cfg(ctx)) === 'running') await ctx.strip.select?.(view).catch(() => {});
  await draw(ctx);
}

// ---- the module's own settings ------------------------------------------------------------------------

async function setConfig(ctx: C, changes: Partial<Config>): Promise<void> {
  const next = { ...cfg(ctx) };
  if (changes.mode !== undefined) {
    if (!['', 'satellite', 'local'].includes(changes.mode)) return;
    next.mode = changes.mode;
  }
  if (changes.host !== undefined) {
    const a = String(changes.host).trim();
    if (!validAddress(a)) {
      await ctx.notify('That is not an IP address or host name', 'warning');
      return draw(ctx);
    }
    next.host = a;
  }
  if (changes.port !== undefined) {
    const p = Number(changes.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      await ctx.notify('Port must be 1 to 65535', 'warning');
      return draw(ctx);
    }
    next.port = p;
  }
  if (changes.grid !== undefined) {
    if (!(changes.grid in GRIDS)) return;
    next.grid = changes.grid;
  }
  if (changes.companionDir !== undefined) {
    const d = String(changes.companionDir).trim();
    // Empty means look in the usual places again.
    if ((d && !path.isAbsolute(d)) || d.length > 512) {
      await ctx.notify('Companion folder must be a full path, such as /opt/companion', 'warning');
      return draw(ctx);
    }
    next.companionDir = d;
  }
  const before = cfg(ctx);
  await ctx.setConfig(next);
  if (rt && phase(next) !== 'running') rt.view = 'buttons';
  apply(ctx);
  if (before.grid !== next.grid && phase(next) === 'running') await ctx.notify(`Touch surface re-registered as ${GRIDS[next.grid].label}`);
  await strip(ctx);
  await draw(ctx);
}

export default defineModule<State, Config>({
  // The panel UI fills a taller screen too (1824×1080 on a 16:9 one). Controllers before 0.22.0 ignore it.
  fullPanel: true,
  async start(ctx) {
    rt?.client?.stop();
    await rt?.runner?.stop();
    rt = {
      ctx,
      client: null,
      runner: null,
      view: 'buttons',
      held: new Map(),
      clientHeld: new Map(),
      deckHeld: new Set(),
      dirty: { deck: new Set(), touch: new Set(), timer: null },
      update: newUpdate()
    };
    await ctx.state.init({});
    await strip(ctx);
    apply(ctx); // registers the surfaces; presses only ever come from a touch
    await draw(ctx);
  },

  async stop() {
    const r = rt;
    rt = null;
    if (!r) return;
    if (r.dirty.timer) clearTimeout(r.dirty.timer);
    r.client?.removeAllListeners();
    r.client?.stop();
    await r.runner?.stop();
  },

  async key(ctx, { index, action }) {
    if (!rt) return;
    const p = phase(cfg(ctx));
    if (p === 'choose') {
      if (action !== 'down') return;
      if (index === at(grid(ctx), KEY.RUN_LOCAL)) return setConfig(ctx, { mode: 'local' });
      if (index === at(grid(ctx), KEY.RUN_SATELLITE)) return setConfig(ctx, { mode: 'satellite' });
      return;
    }
    if (p === 'host') {
      if (action === 'down' && index === at(grid(ctx), KEY.BACK)) return setConfig(ctx, { mode: '' });
      return;
    }
    const keys = surfaceIds().keys;
    if (action === 'down') {
      if (rt.deckHeld.has(index)) return;
      const before = rt.held.get(`${keys}:${index}`) ?? 0;
      press(keys, index, true);
      if ((rt.held.get(`${keys}:${index}`) ?? 0) > before) rt.deckHeld.add(index);
    } else if (rt.deckHeld.delete(index)) {
      press(keys, index, false);
    }
  },

  fullDeck: true,

  // Another deck was plugged in: Companion gets the keys surface again at the new size, which
  // redraws every key from Companion's own buttons.
  async deck(ctx) {
    releaseDeck();
    apply(ctx);
    await ctx.keys.clear();
    await draw(ctx);
  },

  keysOwned(ctx, owned) {
    // The system borrowed the keys (panel lock, a keypad): let go of anything held, then redraw on return.
    if (!owned) releaseDeck();
    else void draw(ctx);
  },

  visibility(_ctx, visible) {
    // A hidden panel UI sends no pointerup: let go of what the touch screen was holding.
    if (!visible && rt) for (const id of [...rt.clientHeld.keys()]) releaseClient(id);
  },

  async strip(ctx, id) {
    if (!rt || !['buttons', 'status', 'setup'].includes(id)) return;
    rt.view = id as View;
    await draw(ctx);
  },

  async client(ctx, { clientId, action }) {
    if (action === 'connect') await draw(ctx, clientId);
    else releaseClient(clientId);
  },

  async ui(ctx, { clientId, message: m }) {
    if (!rt || typeof m !== 'object' || m === null) return;
    switch (m.type) {
      case 'hello':
        return draw(ctx, clientId);
      case 'touch': {
        // From the panel's grid, or from the web view's copy of either surface.
        const which: Which = m.surface === 'keys' ? 'keys' : 'touch';
        const key = Number(m.key);
        const g = which === 'keys' ? grid(ctx) : GRIDS[cfg(ctx).grid];
        if (Number.isInteger(key) && key >= 0 && key < g.columns * g.rows) touch(clientId, which, key, !!m.pressed);
        return;
      }
      case 'release-all':
        return releaseClient(clientId);
      case 'view':
        if (['buttons', 'status', 'setup'].includes(m.view)) return showView(ctx, m.view);
        return draw(ctx);
      case 'choose':
        if (m.mode === 'local' || m.mode === 'satellite' || m.mode === '') return setConfig(ctx, { mode: m.mode });
        return;
      case 'config':
        return setConfig(ctx, m.config ?? {});
      case 'reconnect':
        apply(ctx, true);
        return draw(ctx);
      case 'update-check':
        // Asked for by the web Setup page; at most once a minute unless pressed.
        if (!m.force && rt.update.checkedAt && Date.now() - rt.update.checkedAt < 60_000) return;
        return checkUpdate(ctx);
      case 'update-install':
        return installUpdate(ctx);
      case 'restart':
        if (rt.runner) await rt.runner.restart();
        else apply(ctx, true);
        return draw(ctx);
    }
  }
});
