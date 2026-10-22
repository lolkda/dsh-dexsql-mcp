import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import {
  PLATFORMS,
  assertUpstreamLicenses,
  buildPackage,
  main,
  normalizeTag,
  parseChecksums,
  resolveVersion,
  validateRelease,
} from '../scripts/sync-dexsql.mjs';

const ASSET_NAMES = [...PLATFORMS.map((platform) => platform.asset), 'LICENSE', 'LICENSE-AUXILIARY'];
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const fixtureFiles = () => new Map(ASSET_NAMES.map((name) => {
  let content = `fixture for ${name}\n`;
  if (name === 'dexsql-linux-amd64') content = '#!/bin/sh\nprintf "fake-dexsql %s\\n" "$*"\n';
  if (name === 'LICENSE') content = 'DexSQL Binary License\nVersion 1.0\n';
  if (name === 'LICENSE-AUXILIARY') content = 'MIT License\n';
  return [name, Buffer.from(content)];
}));

const checksumText = (files) => `${ASSET_NAMES.map((name) => `${sha256(files.get(name))}  ${name}`).join('\n')}\n`;

const releaseDocument = (baseUrl, tag = 'v0.1.1') => ({
  tag_name: tag,
  html_url: `https://github.com/LSPosed/dexsql-release/releases/tag/${tag}`,
  draft: false,
  prerelease: false,
  assets: [...ASSET_NAMES, 'SHA256SUMS'].map((name) => ({
    name,
    browser_download_url: `${baseUrl}/download/${name}`,
  })),
});

test('accepts only stable upstream release tags', () => {
  assert.deepEqual(normalizeTag('v0.1.1'), { tag: 'v0.1.1', version: '0.1.1' });
  assert.deepEqual(normalizeTag(' 0.2.0 '), { tag: 'v0.2.0', version: '0.2.0' });
  for (const invalid of ['v0.1', 'v0.1.1-rc.1', 'release-0.1.1', '']) {
    assert.throws(() => normalizeTag(invalid), /expected vMAJOR\.MINOR\.PATCH/);
  }
});

test('parses and validates the upstream SHA256SUMS file', () => {
  const files = fixtureFiles();
  const checksums = parseChecksums(checksumText(files));
  assert.equal(checksums.get('dexsql-linux-amd64'), sha256(files.get('dexsql-linux-amd64')));
  assert.throws(() => parseChecksums('not a checksum\n'), /invalid SHA256SUMS line/);
  assert.throws(() => parseChecksums(`${sha256('x')}  LICENSE\n`), /missing checksum for dexsql-linux-amd64/);
});

test('validates that every supported platform and license asset exists', () => {
  const release = validateRelease(releaseDocument('https://example.test'));
  assert.equal(release.tag, 'v0.1.1');
  assert.equal(release.version, '0.1.1');
  assert.equal(release.assets.size, ASSET_NAMES.length + 1);

  const missing = releaseDocument('https://example.test');
  missing.assets = missing.assets.filter((asset) => asset.name !== 'dexsql-windows-arm64.exe');
  assert.throws(() => validateRelease(missing), /missing asset dexsql-windows-arm64\.exe/);

  assert.throws(() => validateRelease({ ...releaseDocument('https://example.test'), prerelease: true }), /stable/);
});

test('refuses upstream licenses that no longer match the redistribution terms', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dexsql-license-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'LICENSE'), 'DexSQL Binary License\nVersion 1.0\n');
  await writeFile(join(dir, 'LICENSE-AUXILIARY'), 'MIT License\n');
  await assert.doesNotReject(assertUpstreamLicenses(dir));

  await writeFile(join(dir, 'LICENSE'), 'All rights reserved.\n');
  await assert.rejects(assertUpstreamLicenses(dir), /expected DexSQL Binary License/);

  await writeFile(join(dir, 'LICENSE'), 'DexSQL Binary License\nVersion 1.0\n');
  await writeFile(join(dir, 'LICENSE-AUXILIARY'), 'Apache License\n');
  await assert.rejects(assertUpstreamLicenses(dir), /expected MIT license/);
});

test('refuses unsafe output directories before downloading', async () => {
  await assert.rejects(main(['--out', '/'], {}), /refusing to use/);
});

test('resolves the next package version and skips an already packaged upstream release', () => {
  assert.deepEqual(resolveVersion({ repoVersion: '0.2.0', packument: null, upstreamVersion: '0.1.1' }), {
    version: '0.2.0',
    skip: false,
  });

  assert.deepEqual(resolveVersion({
    repoVersion: '0.2.0',
    packument: {
      'dist-tags': { latest: '0.2.0' },
      versions: { '0.2.0': { version: '0.2.0', dexsql: { version: '0.1.1' } } },
    },
    upstreamVersion: '0.1.1',
  }), { version: '0.2.0', skip: true });

  assert.deepEqual(resolveVersion({
    repoVersion: '0.2.0',
    packument: {
      'dist-tags': { latest: '0.1.2' },
      versions: { '0.1.2': { version: '0.1.2' } },
    },
    upstreamVersion: '0.1.1',
  }), { version: '0.2.0', skip: false });

  assert.deepEqual(resolveVersion({
    repoVersion: '0.2.0',
    packument: {
      'dist-tags': { latest: '0.2.0' },
      versions: { '0.2.0': { version: '0.2.0', dexsql: { version: '0.1.0' } } },
    },
    upstreamVersion: '0.1.1',
  }), { version: '0.2.1', skip: false });
});

test('builds one npm package with all platform binaries and the launcher', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dexsql-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assetsDir = join(root, 'assets');
  const outDir = join(root, 'npm');
  await mkdir(assetsDir, { recursive: true });
  const files = fixtureFiles();
  for (const [name, content] of files) await writeFile(join(assetsDir, name), content);

  const manifest = await buildPackage({
    version: '0.2.0',
    upstreamVersion: '0.1.1',
    tag: 'v0.1.1',
    assetsDir,
    outDir,
    releaseUrl: 'https://github.com/LSPosed/dexsql-release/releases/tag/v0.1.1',
    checksums: parseChecksums(checksumText(files)),
  });

  assert.equal(manifest.changed, true);
  assert.equal(manifest.version, '0.2.0');
  assert.equal(manifest.upstreamVersion, '0.1.1');
  assert.equal(manifest.packageDir, 'package');

  const packageDir = join(outDir, 'package');
  const pkg = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@lolkda/dsh-dexsql-mcp');
  assert.equal(pkg.version, '0.2.0');
  assert.equal(pkg.license, 'SEE LICENSE IN LICENSE');
  assert.deepEqual(pkg.bin, { dexsql: 'bin/dexsql.mjs' });
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.equal(pkg.dexsql.version, '0.1.1');
  assert.ok(pkg.files.includes('vendor/**'));
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.optionalDependencies, undefined);

  for (const platform of PLATFORMS) {
    const binary = await stat(join(packageDir, 'vendor', platform.id, platform.binary));
    assert.notEqual(binary.mode & 0o111, 0, `${platform.id} binary must be executable`);
  }
  const launcher = await stat(join(packageDir, 'bin', 'dexsql.mjs'));
  assert.notEqual(launcher.mode & 0o111, 0, 'the launcher must be executable');
  assert.match(await readFile(join(packageDir, 'cordis.patch.yml'), 'utf8'), /@lolkda\/dsh-dexsql-mcp\/bin\/dexsql\.mjs/);
  assert.ok((await readFile(join(packageDir, 'LICENSE'))).length > 0);
  assert.ok((await readFile(join(packageDir, 'LICENSE-AUXILIARY'))).length > 0);
  assert.ok((await readFile(join(packageDir, 'LICENSE-WRAPPER'))).length > 0);

  const vendorManifest = JSON.parse(await readFile(join(packageDir, 'vendor', 'manifest.json'), 'utf8'));
  assert.equal(vendorManifest.version, '0.1.1');
  assert.equal(vendorManifest.checksums['dexsql-linux-amd64'], sha256(files.get('dexsql-linux-amd64')));

  await assert.rejects(
    () => buildPackage({
      version: '0.2.0',
      upstreamVersion: '0.1.1',
      tag: 'v0.1.1',
      assetsDir,
      outDir: '/',
      releaseUrl: 'https://example.test',
      checksums: parseChecksums(checksumText(files)),
    }),
    /refusing to use/,
  );
});

test('bundled launcher selects the vendored platform binary', { skip: process.platform !== 'linux' || process.arch !== 'x64' }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dexsql-launcher-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assetsDir = join(root, 'assets');
  const outDir = join(root, 'npm');
  await mkdir(assetsDir, { recursive: true });
  const files = fixtureFiles();
  for (const [name, content] of files) await writeFile(join(assetsDir, name), content);
  await buildPackage({
    version: '0.2.0',
    upstreamVersion: '0.1.1',
    tag: 'v0.1.1',
    assetsDir,
    outDir,
    releaseUrl: 'https://example.test',
    checksums: parseChecksums(checksumText(files)),
  });

  const installed = join(root, 'profile/node_modules/@lolkda/dsh-dexsql-mcp');
  await mkdir(join(root, 'profile/node_modules/@lolkda'), { recursive: true });
  await cp(join(outDir, 'package'), installed, { recursive: true });
  const output = execFileSync(process.execPath, [join(installed, 'bin/dexsql.mjs'), '--version'], {
    encoding: 'utf8',
  });
  assert.equal(output, 'fake-dexsql --version\n');
});

test('downloads a release and stages the single package', async (t) => {
  const files = fixtureFiles();
  let tamper = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/repos/LSPosed/dexsql-release/releases/latest'
      || url.pathname === '/repos/LSPosed/dexsql-release/releases/tags/v0.1.1') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(releaseDocument(`http://127.0.0.1:${server.address().port}`)));
      return;
    }
    if (decodeURIComponent(url.pathname) === '/@lolkda/dsh-dexsql-mcp') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        'dist-tags': { latest: '0.2.0' },
        versions: { '0.2.0': { version: '0.2.0', dexsql: { version: '0.1.1' } } },
      }));
      return;
    }
    if (url.pathname.startsWith('/download/')) {
      const name = decodeURIComponent(url.pathname.slice('/download/'.length));
      if (name === 'SHA256SUMS') {
        response.end(checksumText(files));
        return;
      }
      const content = files.get(name);
      if (!content) {
        response.statusCode = 404;
        response.end('not found');
        return;
      }
      response.end(tamper && name === 'dexsql-linux-amd64' ? Buffer.from('tampered') : content);
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const root = await mkdtemp(join(tmpdir(), 'dexsql-sync-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const manifest = await main([
    '--api-base', baseUrl,
    '--registry', baseUrl,
    '--tag', 'v0.1.1',
    '--version', '0.2.0',
    '--out', join(root, 'npm'),
  ], {});
  assert.equal(manifest.changed, true);
  assert.equal(JSON.parse(await readFile(join(root, 'npm/package/package.json'), 'utf8')).version, '0.2.0');

  const unchanged = await main([
    '--api-base', baseUrl,
    '--registry', baseUrl,
    '--tag', 'v0.1.1',
    '--out', join(root, 'unchanged'),
  ], {});
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.version, '0.2.0');

  tamper = true;
  await assert.rejects(
    () => main([
      '--api-base', baseUrl,
      '--registry', baseUrl,
      '--tag', 'v0.1.1',
      '--version', '0.2.0',
      '--out', join(root, 'bad'),
    ], {}),
    /checksum mismatch for dexsql-linux-amd64/,
  );
});

test('publish workflow runs four times a day and publishes the built-in package through OIDC', async () => {
  const workflow = parse(await readFile(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8'));
  assert.deepEqual(workflow.on.schedule, [{ cron: '17 0,4,10,14 * * *' }]);
  assert.equal(workflow.permissions.contents, 'read');
  assert.equal(workflow.permissions['id-token'], 'write');
  const stage = workflow.jobs.publish.steps.find((step) => step.name === 'Stage package from upstream');
  assert.match(stage.run, /scripts\/sync-dexsql\.mjs/);
  const publish = workflow.jobs.publish.steps.find((step) => step.name === 'Publish through npm trusted publishing (OIDC)');
  assert.match(publish.run, /\.build\/npm\/package/);
  assert.match(publish.run, /--provenance/);
});
