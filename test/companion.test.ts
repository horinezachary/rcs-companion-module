import { startTestModule, type TestModule } from '@rcs/module-sdk/testing';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { SatelliteClient, type SurfaceSpec } from '../src/client.js';
import mod, { KEY, surfaceIds, type Config, type State } from '../src/index.js';
import { MockCompanion } from '../src/mock.js';
import { bitmapToPng, encodePng } from '../src/png.js';
import { formatLine, LineReader, parseLine } from '../src/protocol.js';
import { bundledNode, CompanionRunner, findInstall, searchDirs, userConfigDir } from '../src/runner.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let mock: MockCompanion | null = null;
let sim: TestModule<State, Config> | null = null;
let client: SatelliteClient | null = null;
const cleanup: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  await sim?.close();
  client?.stop();
  await mock?.close();
  for (const fn of cleanup.splice(0)) await fn();
  sim = null;
  mock = null;
  client = null;
});

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = performance.now() + ms;
  while (!check()) {
    if (performance.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const IDS = surfaceIds();
const SPECS: SurfaceSpec[] = [
  { id: 'test-keys', name: 'test keys', columns: 5, rows: 3, bitmap: 72 },
  { id: 'test-touch', name: 'test touch', columns: 12, rows: 3, bitmap: 112 }
];

async function startMock(opts: ConstructorParameters<typeof MockCompanion>[0] = {}): Promise<number> {
  mock = new MockCompanion(opts);
  return mock.listen(0);
}

async function startModule(config: Partial<Config>, extra: { reason?: 'boot' | 'restore' | 'user' } = {}) {
  sim = await startTestModule(mod, {
    config: { mode: 'satellite', host: '127.0.0.1', port: 16622, grid: '12x3', companionDir: '/opt/companion', ...config },
    reason: extra.reason
  });
  return sim;
}

/** Waits for both surfaces to be live and drawn. */
async function live(): Promise<void> {
  await until(() => sim!.status?.connection === 'connected' && !!sim!.keys[0]?.image && mock!.devices.size === 2);
  await new Promise((r) => setTimeout(r, 60));
  await sim!.settle();
}

const presses = () => mock!.received.filter((l) => l.startsWith('KEY-PRESS'));
const tilesOf = () =>
  sim!.uiMessages
    .map((m) => m.message)
    .filter((m) => m.type === 'tiles')
    .flatMap((m) => m.tiles);

describe('protocol', () => {
  it('parses quoted values, escapes, flags and replies', () => {
    expect(parseLine('ADD-DEVICE OK DEVICEID="a b" X=1 FLAG')).toEqual({
      command: 'ADD-DEVICE',
      status: 'OK',
      params: { DEVICEID: 'a b', X: '1', FLAG: true }
    });
    expect(parseLine('KEY-STATE DEVICEID=k TEXT="say \\"hi\\""')!.params.TEXT).toBe('say "hi"');
    const line = formatLine('ADD-DEVICE', { DEVICEID: 'x"y', KEYS_TOTAL: 15, TEXT: true });
    expect(line).toBe('ADD-DEVICE DEVICEID="x\\"y" KEYS_TOTAL=15 TEXT=1\n');
    expect(parseLine(line)!.params).toEqual({ DEVICEID: 'x"y', KEYS_TOTAL: '15', TEXT: '1' });
  });

  it('splits lines across chunks', () => {
    const r = new LineReader();
    expect(r.push('PING a\r\nPO')).toEqual(['PING a']);
    expect(r.push('NG b\n')).toEqual(['PONG b']);
  });

  it('turns raw RGB and PNG data URLs into PNG, and drops what it cannot show', () => {
    const rgb = Buffer.alloc(4 * 4 * 3, 0x40);
    const png = Buffer.from(bitmapToPng(rgb.toString('base64'))!, 'base64');
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    const idat = png.indexOf('IDAT');
    const len = png.readUInt32BE(idat - 4);
    expect(inflateSync(png.subarray(idat + 4, idat + 4 + len))).toHaveLength((4 * 3 + 1) * 4);
    const b64 = encodePng(rgb, 4, 4).toString('base64');
    expect(bitmapToPng('data:image/png;base64,' + b64)).toBe(b64);
    expect(bitmapToPng('data:image/webp;base64,AAAA')).toBeUndefined();
    expect(bitmapToPng(Buffer.alloc(10).toString('base64'))).toBeUndefined();
  });
});

describe('client', () => {
  it('registers its surfaces and mirrors what Companion draws, without pressing anything', async () => {
    const port = await startMock();
    client = new SatelliteClient('127.0.0.1', SPECS, { port });
    client.start();
    await until(() => !!client!.surfaces.get('test-touch')!.keys[35]);
    expect(client.companionVersion).toBe('4.1.0-mock');
    const adds = mock!.received.filter((l) => l.startsWith('ADD-DEVICE'));
    expect(adds).toHaveLength(2);
    expect(parseLine(adds[1]!)!.params).toMatchObject({ KEYS_TOTAL: '36', KEYS_PER_ROW: '12', BITMAPS: '112', BITMAP_FORMAT: 'png', BRIGHTNESS: '0' });
    const k = client.surfaces.get('test-keys')!.keys[0]!;
    expect(k.image).toMatch(/^iVBOR/);
    expect(k.text).toBe('CUT');
    expect(k.color).toBe('#5A1E1E');
    expect(presses()).toEqual([]);
  });

  it('turns raw RGB from older Companion into PNG', async () => {
    const port = await startMock({ png: false, apiVersion: '1.5.0', companionVersion: '3.2.0' });
    client = new SatelliteClient('127.0.0.1', SPECS, { port });
    client.start();
    await until(() => !!client!.surfaces.get('test-keys')!.keys[14]);
    expect(mock!.received.find((l) => l.startsWith('ADD-DEVICE'))).not.toMatch(/BITMAP_FORMAT/);
    expect(client.surfaces.get('test-keys')!.keys[14]!.image).toMatch(/^iVBOR/);
  });

  it('registers again after a drop and does not replay presses', async () => {
    const port = await startMock();
    client = new SatelliteClient('127.0.0.1', SPECS, { port, retryMs: 50 });
    client.start();
    await until(() => !!client!.surfaces.get('test-keys')!.registered);
    expect(client.press('test-keys', 2, true)).toBe(true);
    await until(() => mock!.presses.length === 1);
    mock!.dropClients();
    await until(() => !client!.surfaces.get('test-keys')!.registered);
    expect(client.surfaces.get('test-keys')!.keys.every((k) => k === undefined)).toBe(true);
    await until(() => !!client!.surfaces.get('test-keys')!.registered);
    await new Promise((r) => setTimeout(r, 100));
    expect(mock!.presses).toEqual([{ device: 'test-keys', key: 2, pressed: true }]);
  });

  it('drops a Companion that stops answering pings', async () => {
    const port = await startMock();
    client = new SatelliteClient('127.0.0.1', SPECS, { port, pingMs: 50, timeoutMs: 300, retryMs: 5000 });
    client.start();
    await until(() => client!.connection === 'connected');
    mock!.silent = true;
    await until(() => client!.connection === 'disconnected', 2000);
    expect(client.statusText).toMatch(/no answer/);
  });

  it('refuses a Companion with a different major API version', async () => {
    const port = await startMock({ apiVersion: '2.0.0' });
    client = new SatelliteClient('127.0.0.1', SPECS, { port, retryMs: 5000 });
    client.start();
    await until(() => client!.connection === 'disconnected' && /API 2\.0\.0/.test(client!.statusText));
    expect(mock!.received).toEqual([]);
  });

  it('reports a surface Companion refuses', async () => {
    const port = await startMock({ refuse: ['test-touch'] });
    client = new SatelliteClient('127.0.0.1', SPECS, { port });
    client.start();
    await until(() => client!.surfaces.get('test-touch')!.error !== '');
    expect(client.surfaces.get('test-keys')!.registered).toBe(true);
    expect(client.statusText).toMatch(/refused test touch/);
  });
});

describe('module', () => {
  it('asks how to run Companion on first start, with keys 6 and 8', async () => {
    sim = await startTestModule(mod, { config: { mode: '', host: '', port: 16622, grid: '12x3', companionDir: '/opt/companion' } });
    expect(sim.keys[KEY.RUN_LOCAL]).toMatchObject({ label: 'RUN HERE' });
    expect(sim.keys[KEY.RUN_SATELLITE]).toMatchObject({ label: 'CONNECT' });
    expect(sim.strip).toEqual([]);
    await sim.press(KEY.RUN_SATELLITE);
    expect(sim.config.mode).toBe('satellite');
    expect(sim.uiMessages.at(-1)!.message).toMatchObject({ type: 'snapshot', phase: 'host' });
    expect(sim.keys[KEY.BACK]).toMatchObject({ label: 'BACK' });
    const port = await startMock();
    await sim.sendUi({ type: 'config', config: { host: '127.0.0.1', port } });
    await live();
    expect(sim.strip.map((s) => s.id)).toEqual(['buttons', 'status', 'setup']);
  });

  it('only registers its surfaces on start, boot and restore', async () => {
    const port = await startMock();
    for (const reason of ['user', 'boot', 'restore'] as const) {
      await startModule({ port }, { reason });
      await live();
      await sim!.close();
      sim = null;
      await until(() => mock!.devices.size === 0);
    }
    expect(mock!.received.every((l) => /^(ADD-DEVICE|REMOVE-DEVICE)/.test(l))).toBe(true);
    expect(presses()).toEqual([]);
  });

  it('draws Companion on the keys and the touch grid', async () => {
    const port = await startMock();
    await startModule({ port });
    await live();
    expect(sim!.keys[0]!.image).toMatch(/^iVBOR/);
    expect(sim!.keys[14]!.image).toMatch(/^iVBOR/);
    await until(() => new Set(tilesOf().filter((t) => t.image).map((t) => t.i)).size === 36);
    for (const m of sim!.uiMessages) expect(JSON.stringify(m.message).length).toBeLessThan(64 * 1024);
  });

  it('sends a key press and release to Companion and shows its answer', async () => {
    const port = await startMock();
    await startModule({ port });
    await live();
    const before = sim!.keys[2]!.image;
    await sim!.press(2);
    await until(() => mock!.presses.length === 2);
    expect(mock!.presses).toEqual([
      { device: IDS.keys, key: 2, pressed: true },
      { device: IDS.keys, key: 2, pressed: false }
    ]);
    await until(() => sim!.keys[2]!.image !== before); // FTB latched on, drawn by Companion
  });

  it('presses touch buttons once however many screens hold them, and lets go on disconnect', async () => {
    const port = await startMock();
    await startModule({ port });
    await live();
    await sim!.connectClient('web-1');
    await sim!.sendUi({ type: 'touch', key: 4, pressed: true }, 'panel');
    await sim!.sendUi({ type: 'touch', key: 4, pressed: true }, 'web-1');
    await sim!.sendUi({ type: 'touch', key: 4, pressed: true }, 'web-1'); // repeat: ignored
    await sim!.sendUi({ type: 'touch', key: 4, pressed: false }, 'panel');
    await until(() => mock!.presses.length === 1);
    expect(mock!.presses[0]).toEqual({ device: IDS.touch, key: 4, pressed: true });
    await sim!.disconnectClient('web-1');
    await until(() => mock!.presses.length === 2);
    expect(mock!.presses[1]).toEqual({ device: IDS.touch, key: 4, pressed: false });
    await sim!.sendUi({ type: 'touch', key: 99, pressed: true }, 'panel');
    await sim!.settle();
    expect(mock!.presses).toHaveLength(2);
  });

  it('presses Stream Deck keys from the web view and sends it both surfaces', async () => {
    const port = await startMock();
    await startModule({ port });
    await live();
    await sim!.connectClient('web-1');
    await until(() => sim!.uiMessages.some((m) => m.clientId === 'web-1' && m.message.type === 'tiles' && m.message.surface === 'keys'));
    const keys = sim!.uiMessages.filter((m) => m.clientId === 'web-1' && m.message.surface === 'keys').flatMap((m) => m.message.tiles);
    expect(keys).toHaveLength(15);
    expect(keys[0].image).toMatch(/^iVBOR/);
    await sim!.sendUi({ type: 'touch', surface: 'keys', key: 9, pressed: true }, 'web-1');
    await sim!.sendUi({ type: 'touch', surface: 'keys', key: 9, pressed: false }, 'web-1');
    await until(() => mock!.presses.length === 2);
    expect(mock!.presses[0]).toEqual({ device: IDS.keys, key: 9, pressed: true });
  });

  it('moves the strip highlight when the panel UI changes page', async () => {
    const port = await startMock();
    await startModule({ port });
    await live();
    expect(sim!.activeStrip).toBe('buttons');
    await sim!.sendUi({ type: 'view', view: 'status' });
    expect(sim!.activeStrip).toBe('status');
  });

  it('lets go of a held key when the system borrows the keys', async () => {
    const port = await startMock();
    await startModule({ port });
    await live();
    await sim!.down(3);
    await until(() => mock!.presses.length === 1);
    await sim!.setKeysOwned(false);
    await until(() => mock!.presses.length === 2);
    expect(mock!.presses[1]).toEqual({ device: IDS.keys, key: 3, pressed: false });
    await sim!.setKeysOwned(true);
    await sim!.up(3);
    await sim!.settle();
    expect(mock!.presses).toHaveLength(2);
  });

  it('re-registers the touch surface when the grid changes', async () => {
    const port = await startMock();
    await startModule({ port });
    await live();
    await sim!.sendUi({ type: 'config', config: { grid: '8x2' } });
    await until(() => mock!.devices.get(IDS.touch)?.columns === 8);
    expect(mock!.received.filter((l) => l.startsWith('REMOVE-DEVICE'))).toHaveLength(1);
    expect(mock!.devices.get(IDS.touch)).toMatchObject({ rows: 2, bitmap: 160 });
    expect(sim!.config.grid).toBe('8x2');
    await until(() => tilesOf().some((t) => t.i === 15 && t.image));
    expect(presses()).toEqual([]);
  });

  it('checks the address before using it', async () => {
    const port = await startMock();
    await startModule({ port });
    await live();
    await sim!.sendUi({ type: 'config', config: { host: 'not an address!' } });
    expect(sim!.config.host).toBe('127.0.0.1');
    expect(sim!.notifications.at(-1)?.text).toMatch(/not an IP address/);
  });

  it('shows the keys as offline while Companion is unreachable', async () => {
    const port = await startMock();
    await mock!.close();
    mock = null;
    await startModule({ port });
    await until(() => sim!.status?.connection === 'disconnected');
    await sim!.settle();
    expect(sim!.keys[KEY.STATUS]).toMatchObject({ label: 'OFFLINE' });
  });
});

describe('Companion on this panel', () => {
  /** A stand-in for Companion's headless build: a launcher that starts the mock on a given port. */
  async function fakeInstall(port: number): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rcs-companion-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const cli = path.join(here, '..', 'dist', 'mock-cli.js');
    await writeFile(path.join(dir, 'companion_headless.sh'), `#!/bin/sh\necho "args: $*"\nexec "${process.execPath}" "${cli}" --port ${port}\n`);
    await chmod(path.join(dir, 'companion_headless.sh'), 0o755);
    return dir;
  }

  it('starts Companion, restarts it when it exits, and stops it', async () => {
    const dir = await fakeInstall(0);
    const configDir = path.join(dir, 'config');
    const runner = new CompanionRunner({ dir, configDir, restartMs: 50 });
    cleanup.push(() => runner.stop(500));
    runner.start();
    await until(() => runner.state === 'running' && runner.tail.some((l) => l.startsWith('Mock Companion')));
    expect(runner.tail[0]).toBe(`args: --admin-address 0.0.0.0 --admin-port 8000 --config-dir ${configDir}`);
    const pid = runner.pid!;
    expect(Number(await readFile(runner.pidFile, 'utf8'))).toBe(pid);
    process.kill(pid, 'SIGKILL');
    await until(() => runner.restarts === 1 && runner.state === 'running' && runner.pid !== pid);
    expect(runner.lastExit).toMatch(/SIGKILL/);
    const second = runner.pid!;
    await runner.stop();
    expect(runner.state).toBe('stopped');
    expect(() => process.kill(second, 0)).toThrow();
  });

  it('looks for Companion in the usual places for each platform', () => {
    expect(searchDirs('linux', {}, '/home/rcs')).toContain('/opt/companion');
    expect(searchDirs('darwin', {}, '/Users/zac')).toEqual(expect.arrayContaining(['/Applications/Companion.app', '/Users/zac/Applications/Companion.app']));
    expect(searchDirs('win32', { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\zac\\AppData\\Local' }, 'C:\\Users\\zac')).toEqual([
      'C:\\Program Files\\Companion',
      'C:\\Users\\zac\\AppData\\Local\\Programs\\Companion'
    ]);
  });

  it('finds a headless build or a desktop install among several folders', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rcs-find-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const app = path.join(root, 'Companion.app');
    const res = path.join(app, 'Contents', 'Resources');
    await mkdir(path.join(res, 'node-runtimes', 'main', 'bin'), { recursive: true });
    await writeFile(path.join(res, 'main.js'), '');
    await writeFile(path.join(res, 'node-runtimes', 'main', 'bin', 'node'), '');
    expect(findInstall([path.join(root, 'nothing'), app])).toEqual({ kind: 'desktop', dir: res, command: path.join(res, 'node-runtimes', 'main', 'bin', 'node'), args: [path.join(res, 'main.js')] });
    const headless = await fakeInstall(0);
    expect(findInstall([app.replace('Companion.app', 'x'), headless])).toMatchObject({ dir: headless, command: path.join(headless, 'companion_headless.sh') });
    expect(findInstall([path.join(root, 'nothing')])).toBeNull();
  });

  it('finds the node a Companion 5 desktop app asks for, with no main runtime', async () => {
    // Companion 5.1 on macOS: node-runtimes/{node18,node22,node26}, no "main" link, engines.node 26.
    const root = await mkdtemp(path.join(os.tmpdir(), 'rcs-find5-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const res = path.join(root, 'Companion.app', 'Contents', 'Resources');
    for (const n of ['node18', 'node22', 'node26']) {
      await mkdir(path.join(res, 'node-runtimes', n, 'bin'), { recursive: true });
      await writeFile(path.join(res, 'node-runtimes', n, 'bin', 'node'), '');
    }
    await writeFile(path.join(res, 'main.js'), '');
    await writeFile(path.join(res, 'package.json'), JSON.stringify({ name: 'companion', engines: { node: '22.1.0' } }));
    expect(bundledNode(res)).toBe(path.join(res, 'node-runtimes', 'node22', 'bin', 'node'));
    await writeFile(path.join(res, 'package.json'), JSON.stringify({ name: 'companion' }));
    expect(findInstall([path.join(root, 'Companion.app')])).toEqual({ kind: 'desktop', dir: res, command: path.join(res, 'node-runtimes', 'node26', 'bin', 'node'), args: [path.join(res, 'main.js')] });
  });

  it("starts a desktop install with the desktop app's own config", async () => {
    expect(userConfigDir('darwin', {}, '/Users/zac')).toBe('/Users/zac/Library/Application Support/companion');
    expect(userConfigDir('win32', { APPDATA: 'C:\\Users\\zac\\AppData\\Roaming' }, 'C:\\Users\\zac')).toBe('C:\\Users\\zac\\AppData\\Roaming\\companion');
    expect(userConfigDir('linux', {}, '/home/zac')).toBe('/home/zac/.config/companion');
    expect(userConfigDir('darwin', { COMPANION_CONFIG_BASEDIR: '/srv/companion' }, '/Users/zac')).toBe('/srv/companion');

    const root = await mkdtemp(path.join(os.tmpdir(), 'rcs-desk-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const res = path.join(root, 'Companion.app', 'Contents', 'Resources');
    await mkdir(path.join(res, 'node-runtimes', 'node26', 'bin'), { recursive: true });
    await writeFile(path.join(res, 'main.js'), '');
    await writeFile(path.join(res, 'node-runtimes', 'node26', 'bin', 'node'), '');
    const desk = new CompanionRunner({ dir: path.join(root, 'Companion.app'), configDir: path.join(root, 'module'), desktopConfigDir: path.join(root, 'app-config') });
    desk.found = findInstall(desk.searched);
    expect(desk.companionConfigDir).toBe(path.join(root, 'app-config'));
    const headless = await fakeInstall(0);
    const panel = new CompanionRunner({ dir: headless, configDir: path.join(root, 'module'), desktopConfigDir: path.join(root, 'app-config') });
    panel.found = findInstall(panel.searched);
    expect(panel.companionConfigDir).toBe(path.join(root, 'module'));
  });

  it('uses a Companion that is already running instead of starting another', async () => {
    const busy = net.createServer().listen(0, '127.0.0.1');
    await new Promise((r) => busy.once('listening', r));
    cleanup.push(() => new Promise<void>((r) => busy.close(() => r())));
    const port = (busy.address() as net.AddressInfo).port;
    const dir = await fakeInstall(0);
    const runner = new CompanionRunner({ dir, configDir: path.join(dir, 'config'), satellitePort: port, adminPort: port });
    cleanup.push(() => runner.stop(500));
    runner.start();
    await until(() => runner.state === 'external');
    expect(runner.pid).toBeNull();
  });

  it('runs the first Companion it finds when no folder is set', async () => {
    const dir = await fakeInstall(0);
    const runner = new CompanionRunner({ dir: '', search: ['/nonexistent/companion', dir], configDir: path.join(dir, 'config') });
    cleanup.push(() => runner.stop(500));
    runner.start();
    await until(() => runner.state === 'running');
    expect(runner.dir).toBe(dir);
    expect(runner.searched).toEqual(['/nonexistent/companion', dir]);
  });

  it('says so when Companion is not installed', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rcs-companion-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    await startModule({ mode: 'local', companionDir: dir });
    await until(() => /not in /.test(sim!.status?.text ?? ''));
    await sim!.settle();
    expect(sim!.keys[KEY.STATUS]).toMatchObject({ label: 'NOT FOUND' });
  });

  it('runs Companion and connects to it on this panel', async () => {
    // The local mode uses the standard Satellite port, so this needs 16622 free.
    const free = await new Promise<boolean>((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.listen(16622, '127.0.0.1', () => s.close(() => resolve(true)));
    });
    if (!free) return;
    const dir = await fakeInstall(16622);
    await startModule({ mode: 'local', companionDir: dir });
    await until(() => sim!.status?.connection === 'connected' && !!sim!.keys[0]?.image, 8000);
    const snap = sim!.uiMessages.map((m) => m.message).filter((m) => m.type === 'snapshot').at(-1);
    expect(snap.runner).toMatchObject({ state: 'running', dir });
    await sim!.close();
    sim = null;
  });
});
