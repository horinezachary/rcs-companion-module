// Runs Companion itself on this panel, for the "Companion on this device" choice. It finds an
// installed Companion, starts it, keeps it running and stops it with the module. The module then
// talks to it over the Satellite API on 127.0.0.1, like any other Companion.
//
// Two kinds of install are recognised in a folder:
//   - Bitfocus's headless build for Linux and the Pi: companion_headless.sh
//   - a desktop install's server (macOS, Windows): main.js beside its bundled node runtime
// With no folder set, the usual install places for the platform are searched (searchDirs).

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** 'external': a Companion someone else started (the desktop app, say) already holds the ports, so it is used. */
export type RunState = 'stopped' | 'starting' | 'running' | 'missing' | 'restarting' | 'external';

export const LAUNCHER = 'companion_headless.sh';
export const ADMIN_PORT = 8000;
export const SATELLITE_PORT = 16622;

export interface RunnerOptions {
  /** Folder holding Companion. Empty: search the usual places (searchDirs). */
  dir: string;
  /** Places to look when dir is empty. Defaults to searchDirs() for this platform. */
  search?: string[];
  /** Where Companion keeps its buttons, pages and connections. */
  configDir: string;
  adminPort?: number;
  /** Companion's Satellite port, checked with the admin port to see whether a Companion is already running. */
  satellitePort?: number;
  /** First restart delay after Companion exits by itself; doubles up to a minute. */
  restartMs?: number;
}

export interface CompanionRunner {
  on(event: 'change', fn: () => void): this;
}

export class CompanionRunner extends EventEmitter {
  state: RunState = 'stopped';
  pid: number | null = null;
  startedAt: number | null = null;
  /** Times Companion exited by itself and was started again. */
  restarts = 0;
  lastExit = '';
  /** The last lines Companion printed, for the Status page. */
  readonly tail: string[] = [];

  private child: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;
  private wanted = false;
  private delay: number;
  /** The folder set in config, or '' to search. */
  readonly wantedDir: string;
  /** Where Companion was found, once it was. */
  found: Install | null = null;
  /** Every folder looked in, for the "not installed" message. */
  readonly searched: string[];
  readonly configDir: string;
  readonly adminPort: number;
  readonly satellitePort: number;
  private readonly restartMs: number;

  constructor(opts: RunnerOptions) {
    super();
    this.wantedDir = opts.dir;
    this.searched = opts.dir ? [opts.dir] : (opts.search ?? searchDirs());
    this.configDir = opts.configDir;
    this.adminPort = opts.adminPort ?? ADMIN_PORT;
    this.satellitePort = opts.satellitePort ?? SATELLITE_PORT;
    this.restartMs = opts.restartMs ?? 2000;
    this.delay = this.restartMs;
  }

  /** Records the running Companion, so one left behind by a module that was killed can be stopped. */
  get pidFile(): string {
    return path.join(this.configDir, 'rcs-companion.pid');
  }

  /** The folder Companion runs from: where it was found, else the folder asked for. */
  get dir(): string {
    return this.found?.dir ?? this.wantedDir;
  }

  start(): void {
    if (this.wanted) return;
    this.wanted = true;
    void this.launch();
  }

  /** Stops Companion: SIGTERM, then SIGKILL if it is still running after `graceMs`. */
  async stop(graceMs = 5000): Promise<void> {
    this.wanted = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const kill = setTimeout(() => signalGroup(child.pid, 'SIGKILL'), graceMs);
        child.once('exit', () => {
          clearTimeout(kill);
          resolve();
        });
        signalGroup(child.pid, 'SIGTERM');
      });
    }
    this.child = null;
    await rm(this.pidFile, { force: true });
    this.set('stopped');
  }

  async restart(): Promise<void> {
    await this.stop();
    this.delay = this.restartMs;
    this.start();
  }

  private async launch(): Promise<void> {
    this.timer = null;
    if (!this.wanted) return;
    await mkdir(this.configDir, { recursive: true });
    await this.stopLeftover();
    if (!this.wanted) return;
    this.found = findInstall(this.searched);
    // A Companion that is already running here (the desktop app, or one started by hand) holds the
    // ports, so a second one could not start. Use that one, and look again now and then.
    if ((await listening(this.satellitePort)) || (await listening(this.adminPort))) {
      if (!this.wanted) return;
      if (this.state !== 'external') this.set('external');
      this.timer = setTimeout(() => void this.launch(), 10_000);
      return;
    }
    if (!this.found) {
      if (!this.wanted) return;
      this.set('missing');
      // Look again now and then, so installing Companion needs no restart of the module.
      this.timer = setTimeout(() => void this.launch(), 10_000);
      return;
    }
    if (!this.wanted) return;
    this.set('starting');
    const { command, args, dir } = this.found;
    const child = spawn(
      command,
      [...args, '--admin-address', '0.0.0.0', '--admin-port', String(this.adminPort), '--config-dir', this.configDir],
      // Its own process group, so stopping it also stops the node process the launcher starts.
      { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], detached: true, windowsHide: true }
    );
    this.child = child;
    const keep = (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.tail.push(line.slice(0, 300));
        if (this.tail.length > 40) this.tail.shift();
      }
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.on('spawn', () => {
      if (this.child !== child) return;
      this.pid = child.pid ?? null;
      this.startedAt = Date.now();
      void writeFile(this.pidFile, String(child.pid)).catch(() => {});
      this.set('running');
    });
    let ended = false;
    const onEnd = (why: string) => {
      if (ended || this.child !== child) return;
      ended = true;
      // A Companion that ran a while gets a quick restart; one that keeps crashing backs off.
      if (this.startedAt && Date.now() - this.startedAt > 30_000) this.delay = this.restartMs;
      this.child = null;
      this.pid = null;
      this.startedAt = null;
      this.lastExit = why;
      if (!this.wanted) return this.set('stopped');
      this.restarts++;
      this.set('restarting');
      this.timer = setTimeout(() => void this.launch(), this.delay);
      this.delay = Math.min(this.delay * 2, 60_000);
    };
    // A launcher that cannot run (not executable, say) gives error and no exit.
    child.on('error', (e) => onEnd(e.message));
    child.on('exit', (code, signal) => onEnd(signal ? `stopped by ${signal}` : `exited with code ${code}`));
  }

  /** A Companion from before the module was last killed would hold the ports: stop it first. */
  private async stopLeftover(): Promise<void> {
    const pid = Number((await readFile(this.pidFile, 'utf8').catch(() => '')).trim());
    if (!Number.isInteger(pid) || pid <= 1) return;
    const cmd = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
    if (cmd.includes('companion')) {
      signalGroup(pid, 'SIGTERM');
      for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
      if (alive(pid)) signalGroup(pid, 'SIGKILL');
    }
    await rm(this.pidFile, { force: true });
  }

  private set(state: RunState): void {
    this.state = state;
    this.emit('change');
  }
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

/** Whether something accepts connections on this port on this computer. */
export function listening(port: number, host = '127.0.0.1', timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface Install {
  dir: string;
  command: string;
  args: string[];
}

/** The usual places Companion is installed, for this platform. */
export function searchDirs(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string[] {
  if (platform === 'darwin') {
    return ['/Applications/Companion.app', path.join(home, 'Applications', 'Companion.app'), '/opt/companion'];
  }
  if (platform === 'win32') {
    const dirs = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Programs')]
      .filter((d): d is string => !!d)
      .map((d) => path.win32.join(d, 'Companion'));
    return dirs.length ? dirs : ['C:\\Program Files\\Companion'];
  }
  return ['/opt/companion', '/usr/local/companion', '/usr/lib/companion', path.join(home, 'companion'), path.join(home, 'companion-headless')];
}

const NODE_BINS = ['bin/node', 'node', 'node.exe'];

/**
 * The node that runs a desktop install's server. Companion bundles several in node-runtimes/
 * (node22, node26, ...); the one its package.json asks for is used, else `main`, else the newest.
 * Older builds kept a single one in node-runtime/.
 */
export function bundledNode(dir: string): string | null {
  const base = path.join(dir, 'node-runtimes');
  const names: string[] = [];
  try {
    const engines = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))?.engines?.node;
    const major = /(\d+)/.exec(String(engines ?? ''))?.[1];
    if (major) names.push(`node${major}`);
  } catch {
    // no package.json: go by folder names
  }
  names.push('main');
  try {
    const nodeDirs = readdirSync(base)
      .filter((n) => /^node\d+$/.test(n))
      .sort((a, b) => Number(b.slice(4)) - Number(a.slice(4)));
    names.push(...nodeDirs);
  } catch {
    // no node-runtimes folder
  }
  const candidates = [...names.map((n) => path.join(base, n)), path.join(dir, 'node-runtime')];
  for (const c of candidates) {
    for (const b of NODE_BINS) {
      const p = path.join(c, b);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/**
 * The first folder that holds a Companion this module can start. A desktop app's folder works too:
 * its server lives in Contents/Resources (macOS) or resources (Windows).
 */
export function findInstall(dirs: string[]): Install | null {
  for (const d of dirs) {
    for (const dir of [d, path.join(d, 'Contents', 'Resources'), path.join(d, 'resources')]) {
      const sh = path.join(dir, LAUNCHER);
      if (process.platform !== 'win32' && existsSync(sh)) return { dir, command: sh, args: [] };
      const main = path.join(dir, 'main.js');
      if (!existsSync(main)) continue;
      const node = bundledNode(dir);
      if (node) return { dir, command: node, args: [main] };
    }
  }
  return null;
}
