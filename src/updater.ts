// Updates Companion, only when someone presses Update and confirms. Bitfocus's public packages API
// (the one CompanionPi's updater uses) lists each build with a direct download, so no Bitfocus
// sign-in is needed.
//
//   - a headless build (the panel, Linux): download the .tar.gz, stop Companion, put the new build in
//     place (the old one is kept beside it as <dir>.previous), start Companion again.
//   - a desktop app (macOS .dmg, Windows .exe): download the installer to Downloads and open it.
//     Replacing a desktop app that may be running is left to its own installer.

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { Install } from './runner.js';

export const PACKAGES_API = 'https://api.bitfocus.io/v1/product/companion/packages';

export interface Package {
  version: string;
  target: string;
  uri: string;
  published: string;
}

/** Bitfocus's build target for this kind of computer. */
export function packageTarget(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | null {
  const t: Record<string, string> = {
    'darwin-arm64': 'mac-arm',
    'darwin-x64': 'mac-intel',
    'linux-arm64': 'linux-arm64-tgz',
    'linux-x64': 'linux-tgz',
    'win32-x64': 'win-x64',
    'win32-arm64': 'win-arm64'
  };
  return t[`${platform}-${arch}`] ?? null;
}

/** "v5.1.3", "5.1.1+10000-stable-1e2454ae78" and "5.1.1" all become [5, 1, 3] / [5, 1, 1]. */
export function versionParts(v: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Whether `latest` is newer than `installed`; unknown installed counts as older. */
export function isNewer(latest: string, installed: string): boolean {
  const a = versionParts(latest);
  const b = versionParts(installed);
  if (!a) return false;
  if (!b) return true;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** The newest stable build for a target, or null when Bitfocus lists none. */
export async function latestPackage(target: string, opts: { api?: string; channel?: string; fetchImpl?: typeof fetch } = {}): Promise<Package | null> {
  const q = new URLSearchParams({ branch: opts.channel ?? 'stable', limit: '1', target });
  const res = await (opts.fetchImpl ?? fetch)(`${opts.api ?? PACKAGES_API}?${q}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Bitfocus answered ${res.status}`);
  const data = (await res.json()) as { packages?: Partial<Package>[] };
  const p = (data.packages ?? []).find((x) => x.target === target && typeof x.uri === 'string' && typeof x.version === 'string');
  if (!p) return null;
  if (!/^https:\/\//.test(p.uri!) && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(p.uri!)) throw new Error('Bitfocus listed a download that is not https');
  return { version: p.version!, target, uri: p.uri!, published: p.published ?? '' };
}

/** The Companion build in an install folder, from its BUILD file. */
export function installedVersion(install: Install | null): string {
  if (!install) return '';
  for (const f of [path.join(install.dir, 'BUILD'), path.join(install.dir, 'resources', 'BUILD')]) {
    try {
      const v = readFileSync(f, 'utf8').trim();
      if (v) return v;
    } catch {
      // try the next
    }
  }
  return '';
}

/** Downloads `uri` to `dest`, reporting progress, and checks the size the server gave. */
export async function download(uri: string, dest: string, onProgress: (done: number, total: number) => void, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(uri);
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  await mkdir(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  let done = 0;
  let last = 0;
  const count = new Transform({
    transform(c: Buffer, _enc, cb) {
      done += c.length;
      if (done - last > 1024 * 1024) {
        last = done;
        onProgress(done, total);
      }
      cb(null, c);
    }
  });
  await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>), count, createWriteStream(part));
  const size = (await stat(part)).size;
  if (total && size !== total) {
    await rm(part, { force: true });
    throw new Error(`download was cut short (${size} of ${total} bytes)`);
  }
  await rename(part, dest);
  onProgress(size, total || size);
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr?.on('data', (c) => (err += c));
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} failed: ${err.trim().slice(0, 300) || `code ${code}`}`))));
  });
}

/**
 * Puts a headless .tar.gz in place of the install in `dir`. A folder with companion_headless.sh
 * takes the whole build; a CompanionPi-style folder (main.js at the top) takes only its resources.
 * The old build stays in <dir>.previous until the next update.
 */
export async function installTarball(tgz: string, dir: string): Promise<void> {
  const staging = `${dir}.new`;
  const previous = `${dir}.previous`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  const headless = existsSync(path.join(dir, 'companion_headless.sh'));
  if (headless) await run('tar', ['-xzf', tgz, '--strip-components=1', '-C', staging]);
  else await run('tar', ['-xzf', tgz, '--strip-components=2', '-C', staging, '--wildcards', '*/resources']);
  const check = headless ? path.join(staging, 'companion_headless.sh') : path.join(staging, 'main.js');
  if (!existsSync(check)) {
    await rm(staging, { recursive: true, force: true });
    throw new Error('the download does not look like a Companion build');
  }
  await rm(previous, { recursive: true, force: true });
  await rename(dir, previous);
  try {
    await rename(staging, dir);
  } catch (e) {
    await rename(previous, dir).catch(() => {});
    throw e;
  }
}

/** Where a desktop installer is saved: the user's Downloads folder. */
export function downloadsDir(home = os.homedir()): string {
  return path.join(home, 'Downloads');
}

/** Opens a downloaded desktop installer for the person to finish. */
export function openInstaller(file: string, platform: NodeJS.Platform = process.platform): void {
  const [cmd, args] = platform === 'darwin' ? ['open', [file]] : platform === 'win32' ? [file, []] : ['xdg-open', [file]];
  const p = spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore', windowsHide: false });
  p.on('error', () => {});
  p.unref();
}
