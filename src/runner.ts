// Runs Companion itself on this panel, for the "Companion on this device" choice. It starts the
// headless build that Bitfocus publishes for Linux (companion_headless.sh in its folder), keeps it
// running and stops it with the module. The module then talks to it over the Satellite API on
// 127.0.0.1, like any other Companion.

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type RunState = 'stopped' | 'starting' | 'running' | 'missing' | 'restarting';

export const LAUNCHER = 'companion_headless.sh';
export const ADMIN_PORT = 8000;

export interface RunnerOptions {
  /** Folder holding Companion's headless build. */
  dir: string;
  /** Where Companion keeps its buttons, pages and connections. */
  configDir: string;
  adminPort?: number;
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
  readonly dir: string;
  readonly configDir: string;
  readonly adminPort: number;
  private readonly restartMs: number;

  constructor(opts: RunnerOptions) {
    super();
    this.dir = opts.dir;
    this.configDir = opts.configDir;
    this.adminPort = opts.adminPort ?? ADMIN_PORT;
    this.restartMs = opts.restartMs ?? 2000;
    this.delay = this.restartMs;
  }

  /** Records the running Companion, so one left behind by a module that was killed can be stopped. */
  get pidFile(): string {
    return path.join(this.configDir, 'rcs-companion.pid');
  }

  get launcher(): string {
    return path.join(this.dir, LAUNCHER);
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
    if (!existsSync(this.launcher)) {
      this.set('missing');
      // Look again now and then, so installing Companion needs no restart of the module.
      this.timer = setTimeout(() => void this.launch(), 10_000);
      return;
    }
    await mkdir(this.configDir, { recursive: true });
    await this.stopLeftover();
    if (!this.wanted) return;
    this.set('starting');
    const child = spawn(
      this.launcher,
      ['--admin-address', '0.0.0.0', '--admin-port', String(this.adminPort), '--config-dir', this.configDir],
      // Its own process group, so stopping it also stops the node process the launcher starts.
      { cwd: this.dir, stdio: ['ignore', 'pipe', 'pipe'], detached: true }
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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
