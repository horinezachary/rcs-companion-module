import { startTestModule, type TestModule } from '@rcs/module-sdk/testing';
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import mod, { updateSource, type Config, type State } from '../src/index.js';
import { download, installedVersion, installTarball, isNewer, latestPackage, packageTarget } from '../src/updater.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const cleanup: (() => Promise<unknown>)[] = [];
let sim: TestModule<State, Config> | null = null;

afterEach(async () => {
  await sim?.close();
  sim = null;
  for (const k of Object.keys(updateSource)) delete (updateSource as Record<string, unknown>)[k];
  for (const fn of cleanup.splice(0)) await fn();
});

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = performance.now() + ms;
  while (!check()) {
    if (performance.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function tmp(prefix: string): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanup.push(() => rm(d, { recursive: true, force: true }));
  return d;
}

/** A headless Companion build packed like Bitfocus's: <top>/companion_headless.sh and <top>/resources. */
async function fakeBuild(version: string): Promise<string> {
  const root = await tmp('rcs-build-');
  const top = path.join(root, `companion-linux-arm64-${version}`);
  await mkdir(path.join(top, 'resources'), { recursive: true });
  const cli = path.join(here, '..', 'dist', 'mock-cli.js');
  await writeFile(path.join(top, 'companion_headless.sh'), `#!/bin/sh\necho "build ${version}"\nexec "${process.execPath}" "${cli}" --port 0\n`);
  await chmod(path.join(top, 'companion_headless.sh'), 0o755);
  await writeFile(path.join(top, 'resources', 'main.js'), '');
  await writeFile(path.join(top, 'resources', 'BUILD'), `${version}+10036-stable-93ea3fa61c`);
  const tgz = path.join(root, `companion-linux-arm64-${version}.tar.gz`);
  execFileSync('tar', ['-czf', tgz, '-C', root, path.basename(top)]);
  return tgz;
}

/** Bitfocus's packages API and download host, on 127.0.0.1. */
async function fakeBitfocus(tgz: string, version: string, target: string) {
  const asked: string[] = [];
  const server = http.createServer(async (req, res) => {
    asked.push(req.url!);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    if (req.url!.startsWith('/v1/product/companion/packages')) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ packages: [{ published: '2026-11-12T21:44:36.000Z', version, target, uri: `${base}/builds/${path.basename(tgz)}` }] }));
    }
    if (req.url === `/builds/${path.basename(tgz)}`) {
      res.setHeader('content-length', String((await stat(tgz)).size));
      return createReadStream(tgz).pipe(res);
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
  return { api: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/product/companion/packages`, asked };
}

describe('updater', () => {
  it('compares Bitfocus versions and picks the target for this computer', () => {
    expect(isNewer('v5.1.3', '5.1.1+10000-stable-1e2454ae78')).toBe(true);
    expect(isNewer('v5.1.1', '5.1.1+10000-stable-1e2454ae78')).toBe(false);
    expect(isNewer('v5.1.3', '5.2.0+10310-main-97e9b4d44d')).toBe(false);
    expect(isNewer('v5.1.3', '')).toBe(true);
    expect(packageTarget('darwin', 'arm64')).toBe('mac-arm');
    expect(packageTarget('linux', 'arm64')).toBe('linux-arm64-tgz');
    expect(packageTarget('linux', 'x64')).toBe('linux-tgz');
    expect(packageTarget('win32', 'x64')).toBe('win-x64');
  });

  it('reads the latest build from the packages API and puts a headless build in place', async () => {
    const tgz = await fakeBuild('5.1.3');
    const bf = await fakeBitfocus(tgz, 'v5.1.3', 'linux-arm64-tgz');
    const pkg = await latestPackage('linux-arm64-tgz', { api: bf.api });
    expect(pkg).toMatchObject({ version: 'v5.1.3', target: 'linux-arm64-tgz' });
    expect(bf.asked[0]).toBe('/v1/product/companion/packages?branch=stable&limit=1&target=linux-arm64-tgz');

    const work = await tmp('rcs-upd-');
    const file = path.join(work, 'dl', 'build.tar.gz');
    const seen: number[] = [];
    await download(pkg!.uri, file, (d) => seen.push(d));
    expect(seen.at(-1)).toBe((await stat(tgz)).size);

    const dir = path.join(work, 'companion');
    await mkdir(path.join(dir, 'resources'), { recursive: true });
    await writeFile(path.join(dir, 'companion_headless.sh'), 'old');
    await writeFile(path.join(dir, 'resources', 'BUILD'), '5.1.1+10000-stable-1e2454ae78');
    await installTarball(file, dir);
    expect(await readFile(path.join(dir, 'companion_headless.sh'), 'utf8')).toContain('build 5.1.3');
    expect(installedVersion({ kind: 'headless', dir, command: '', args: [] })).toBe('5.1.3+10036-stable-93ea3fa61c');
    expect(await readFile(path.join(dir + '.previous', 'companion_headless.sh'), 'utf8')).toBe('old');
    expect(existsSync(dir + '.new')).toBe(false);
  });

  it('refuses a download that is not a Companion build and keeps the old one', async () => {
    const work = await tmp('rcs-bad-');
    await mkdir(path.join(work, 'x', 'junk'), { recursive: true });
    await writeFile(path.join(work, 'x', 'junk', 'readme'), 'hi');
    const tgz = path.join(work, 'junk.tar.gz');
    execFileSync('tar', ['-czf', tgz, '-C', path.join(work, 'x'), 'junk']);
    const dir = path.join(work, 'companion');
    await mkdir(dir);
    await writeFile(path.join(dir, 'companion_headless.sh'), 'old');
    await expect(installTarball(tgz, dir)).rejects.toThrow(/not look like a Companion build/);
    expect(await readFile(path.join(dir, 'companion_headless.sh'), 'utf8')).toBe('old');
  });

  it('updates the Companion it runs only after Update is pressed', async () => {
    const tgz = await fakeBuild('5.1.3');
    const bf = await fakeBitfocus(tgz, 'v5.1.3', 'linux-arm64-tgz');
    const old = await fakeBuild('5.1.1');
    const work = await tmp('rcs-mod-');
    execFileSync('tar', ['-xzf', old, '-C', work]);
    const dir = path.join(work, 'companion-linux-arm64-5.1.1');
    cleanup.push(() => rm(dir + '.previous', { recursive: true, force: true }));
    Object.assign(updateSource, { api: bf.api, platform: 'linux', arch: 'arm64' });

    sim = await startTestModule(mod, { config: { mode: 'local', host: '', port: 16622, grid: '12x3', companionDir: dir } });
    const snap = () => sim!.uiMessages.map((m) => m.message).filter((m) => m.type === 'snapshot').at(-1);
    await until(() => snap()?.runner?.state === 'running' || snap()?.runner?.state === 'external');
    if (snap().runner.state === 'external') return void console.log('SKIPPED: port in use'); // something else holds port 16622 here
    expect(bf.asked).toEqual([]); // nothing is asked of Bitfocus until someone looks

    await sim.sendUi({ type: 'update-check' }, 'web-1');
    await until(() => snap()?.update?.latest?.version === 'v5.1.3');
    expect(snap().update).toMatchObject({ installed: '5.1.1+10036-stable-93ea3fa61c', available: true, how: 'replace', phase: 'idle' });
    expect(bf.asked.some((u) => u.startsWith('/builds/'))).toBe(false);

    await sim.sendUi({ type: 'update-install' }, 'web-1');
    await until(() => snap()?.update?.phase === 'done' || snap()?.update?.phase === 'error', 15_000);
    expect(snap().update.message).toMatch(/5\.1\.3 is installed/);
    expect(await readFile(path.join(dir, 'companion_headless.sh'), 'utf8')).toContain('build 5.1.3');
    await until(() => snap()?.runner?.state === 'running' && snap()?.update?.installed?.startsWith('5.1.3'), 8000);
    expect(snap().update.available).toBe(false);
  });

  it('downloads a desktop installer and opens it', async () => {
    const tgz = await fakeBuild('5.1.3'); // any file stands in for the .dmg
    const bf = await fakeBitfocus(tgz, 'v5.1.3', 'mac-arm');
    const downloads = await tmp('rcs-dls-');
    const opened: string[] = [];
    Object.assign(updateSource, { api: bf.api, platform: 'darwin', arch: 'arm64', downloads, open: (f: string) => opened.push(f) });
    sim = await startTestModule(mod, { config: { mode: 'local', host: '', port: 16622, grid: '12x3', companionDir: '/nonexistent/companion' } });
    const snap = () => sim!.uiMessages.map((m) => m.message).filter((m) => m.type === 'snapshot').at(-1);
    await sim.sendUi({ type: 'update-check' }, 'web-1');
    await until(() => !!snap()?.update?.latest);
    expect(snap().update).toMatchObject({ how: 'installer', blocked: '' });
    await sim.sendUi({ type: 'update-install' }, 'web-1');
    await until(() => snap()?.update?.phase === 'done' || snap()?.update?.phase === 'error', 15_000);
    expect(opened).toEqual([path.join(downloads, path.basename(tgz))]);
    expect(existsSync(opened[0])).toBe(true);
  });
});
