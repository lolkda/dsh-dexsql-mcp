#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, parse as parsePath, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const LAUNCHER_SOURCE = join(ROOT, 'packaging/dexsql/bin/dexsql.mjs');
const WRAPPER_LICENSE = join(ROOT, 'LICENSE');
const DEFAULT_API_BASE = 'https://api.github.com';
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const DEFAULT_OUT = join(ROOT, '.build/npm');
const SOURCE_REPO = 'LSPosed/dexsql-release';
const PACKAGE_NAME = '@lolkda/dsh-dexsql-mcp';
const SOURCE_URL = `https://github.com/${SOURCE_REPO}`;
const REPO_FILES = ['cordis.patch.yml', 'README.md', 'CHANGELOG.md', 'locale/en.json', 'locale/zh.json'];

export const PLATFORMS = Object.freeze([
  { id: 'linux-x64', asset: 'dexsql-linux-amd64', binary: 'dexsql' },
  { id: 'linux-arm64', asset: 'dexsql-linux-arm64', binary: 'dexsql' },
  { id: 'darwin-x64', asset: 'dexsql-darwin-amd64', binary: 'dexsql' },
  { id: 'darwin-arm64', asset: 'dexsql-darwin-arm64', binary: 'dexsql' },
  { id: 'win32-x64', asset: 'dexsql-windows-amd64.exe', binary: 'dexsql.exe' },
  { id: 'win32-arm64', asset: 'dexsql-windows-arm64.exe', binary: 'dexsql.exe' },
]);

const PLATFORM_ASSETS = PLATFORMS.map((platform) => platform.asset);
const LICENSE_ASSETS = ['LICENSE', 'LICENSE-AUXILIARY'];
const DOWNLOAD_ASSETS = [...PLATFORM_ASSETS, ...LICENSE_ASSETS];
const REQUIRED_ASSETS = [...DOWNLOAD_ASSETS, 'SHA256SUMS'];

const requestHeaders = (token, accept = 'application/vnd.github+json') => ({
  accept,
  'user-agent': 'dsh-dexsql-sync',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

const writeJson = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);

function assertSafeOutputDir(outDir) {
  const resolved = resolve(outDir);
  const components = resolved.split(sep).filter(Boolean);
  const home = process.env.HOME ? resolve(process.env.HOME) : null;
  if (resolved === parsePath(resolved).root || components.length < 2
    || resolved === resolve(ROOT) || resolve(ROOT).startsWith(`${resolved}${sep}`)
    || (home && (resolved === home || home.startsWith(`${resolved}${sep}`)))) {
    throw new Error(`refusing to use ${resolved} as an output directory; choose a dedicated build directory`);
  }
  return resolved;
}

export function parseSemver(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value));
  if (!match) throw new Error(`unsupported package version "${value}"; expected MAJOR.MINOR.PATCH`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

export function nextPatchVersion(value) {
  const { major, minor, patch } = parseSemver(value);
  return `${major}.${minor}.${patch + 1}`;
}

export function resolveVersion({ repoVersion, packument, upstreamVersion }) {
  const latest = packument?.['dist-tags']?.latest;
  const latestManifest = latest ? packument?.versions?.[latest] : undefined;
  if (!latest || !latestManifest) return { version: repoVersion, skip: false };
  if (latestManifest.dexsql?.version === upstreamVersion) {
    return { version: latest, skip: true };
  }

  const repoPublished = Boolean(packument.versions?.[repoVersion]);
  const comparison = compareSemver(repoVersion, latest);
  if (!repoPublished && comparison > 0) return { version: repoVersion, skip: false };
  return { version: nextPatchVersion(comparison > 0 ? repoVersion : latest), skip: false };
}

export function normalizeTag(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Unsupported DexSQL release tag "${value ?? ''}"; expected vMAJOR.MINOR.PATCH`);
  }
  const tag = value.trim();
  if (!/^v?\d+\.\d+\.\d+$/.test(tag)) {
    throw new Error(`Unsupported DexSQL release tag "${value}"; expected vMAJOR.MINOR.PATCH`);
  }
  return {
    tag: tag.startsWith('v') ? tag : `v${tag}`,
    version: tag.replace(/^v/, ''),
  };
}

export function releaseApiUrl(apiBase, tag) {
  const base = apiBase.replace(/\/+$/, '');
  if (!tag) return `${base}/repos/${SOURCE_REPO}/releases/latest`;
  return `${base}/repos/${SOURCE_REPO}/releases/tags/${encodeURIComponent(normalizeTag(tag).tag)}`;
}

export function validateRelease(release) {
  if (!release || typeof release !== 'object') throw new Error('DexSQL release metadata is missing');
  if (release.draft) throw new Error('DexSQL release is a draft');
  if (release.prerelease) throw new Error('DexSQL release is not a stable release');
  const { tag, version } = normalizeTag(release.tag_name);
  if (!Array.isArray(release.assets)) throw new Error(`DexSQL ${tag} has no assets array`);

  const assets = new Map();
  for (const asset of release.assets) {
    if (typeof asset?.name !== 'string' || typeof asset?.browser_download_url !== 'string') {
      throw new Error(`DexSQL ${tag} has a malformed asset entry`);
    }
    if (assets.has(asset.name)) throw new Error(`DexSQL ${tag} lists duplicate asset ${asset.name}`);
    assets.set(asset.name, asset);
  }
  for (const name of REQUIRED_ASSETS) {
    if (!assets.has(name)) throw new Error(`DexSQL ${tag} is missing asset ${name}`);
  }

  return {
    tag,
    version,
    htmlUrl: typeof release.html_url === 'string' ? release.html_url : `${SOURCE_URL}/releases/tag/${tag}`,
    assets,
  };
}

export function parseChecksums(text) {
  const checksums = new Map();
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^([0-9a-fA-F]{64}) [ *]([^/\\]+)$/.exec(line);
    if (!match) throw new Error(`invalid SHA256SUMS line: ${line}`);
    const [, digest, name] = match;
    if (checksums.has(name)) throw new Error(`duplicate checksum for ${name}`);
    checksums.set(name, digest.toLowerCase());
  }
  for (const name of DOWNLOAD_ASSETS) {
    if (!checksums.has(name)) throw new Error(`missing checksum for ${name}`);
  }
  return checksums;
}

export async function assertUpstreamLicenses(assetsDir) {
  const license = await readFile(join(assetsDir, 'LICENSE'), 'utf8');
  if (!license.includes('DexSQL Binary License')) {
    throw new Error('upstream LICENSE is not the expected DexSQL Binary License; refusing to republish');
  }
  const auxiliaryLicense = await readFile(join(assetsDir, 'LICENSE-AUXILIARY'), 'utf8');
  if (!auxiliaryLicense.includes('MIT License')) {
    throw new Error('upstream LICENSE-AUXILIARY is not the expected MIT license; refusing to republish');
  }
}

async function fetchJson(url, { token = '', fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, { headers: requestHeaders(token) });
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  return response.json();
}

async function fetchText(url, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, { headers: requestHeaders('', 'text/plain') });
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  return response.text();
}

async function fetchPackument(packageName, { registry = DEFAULT_REGISTRY, fetchImpl = fetch } = {}) {
  const url = `${registry.replace(/\/+$/, '')}/${encodeURIComponent(packageName)}`;
  const response = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': 'dsh-dexsql-sync' } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  return response.json();
}

async function downloadAsset(url, destination, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, { headers: requestHeaders('', 'application/octet-stream') });
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  await mkdir(dirname(destination), { recursive: true });

  const hash = createHash('sha256');
  if (response.body) {
    const hasher = new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), hasher, createWriteStream(destination));
  } else {
    const content = Buffer.from(await response.arrayBuffer());
    hash.update(content);
    await writeFile(destination, content);
  }
  return hash.digest('hex');
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  let failure;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failure && next < items.length) {
      const index = next++;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        failure ??= error;
      }
    }
  });
  await Promise.all(runners);
  if (failure) throw failure;
  return results;
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function downloadRelease({ release, assetsDir, fetchImpl = fetch, concurrency = 3 }) {
  const checksumsAsset = release.assets.get('SHA256SUMS');
  const checksumsText = await fetchText(checksumsAsset.browser_download_url, { fetchImpl });
  const checksums = parseChecksums(checksumsText);
  await writeFile(join(assetsDir, 'SHA256SUMS'), checksumsText);

  await mapLimit(DOWNLOAD_ASSETS, concurrency, async (name) => {
    const asset = release.assets.get(name);
    const destination = join(assetsDir, name);
    const actual = await downloadAsset(asset.browser_download_url, destination, { fetchImpl });
    const expected = checksums.get(name);
    if (actual !== expected) {
      throw new Error(`checksum mismatch for ${name}: expected ${expected}, got ${actual}`);
    }
    return destination;
  });

  await assertUpstreamLicenses(assetsDir);
  return checksums;
}

function sortedChecksums(checksums) {
  return Object.fromEntries([...checksums.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

export async function buildPackage({ version, upstreamVersion, tag, assetsDir, outDir, releaseUrl, checksums }) {
  parseSemver(version);
  const repoPkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const safeOutDir = assertSafeOutputDir(outDir);
  const stageDir = join(safeOutDir, 'package');
  await rm(safeOutDir, { recursive: true, force: true });
  await mkdir(join(stageDir, 'bin'), { recursive: true });
  await mkdir(join(stageDir, 'locale'), { recursive: true });

  for (const file of REPO_FILES) {
    await copyFile(join(ROOT, file), join(stageDir, file));
    await chmod(join(stageDir, file), 0o644);
  }
  await copyFile(WRAPPER_LICENSE, join(stageDir, 'LICENSE-WRAPPER'));
  await copyFile(LAUNCHER_SOURCE, join(stageDir, 'bin', 'dexsql.mjs'));
  await chmod(join(stageDir, 'LICENSE-WRAPPER'), 0o644);
  await chmod(join(stageDir, 'bin', 'dexsql.mjs'), 0o755);

  for (const license of LICENSE_ASSETS) {
    await copyFile(join(assetsDir, license), join(stageDir, license));
    await chmod(join(stageDir, license), 0o644);
  }

  for (const platform of PLATFORMS) {
    const dir = join(stageDir, 'vendor', platform.id);
    await mkdir(dir, { recursive: true });
    await copyFile(join(assetsDir, platform.asset), join(dir, platform.binary));
    await chmod(join(dir, platform.binary), 0o755);
  }

  await writeJson(join(stageDir, 'vendor', 'manifest.json'), {
    source: SOURCE_URL,
    releaseUrl,
    tag,
    version: upstreamVersion,
    checksums: sortedChecksums(checksums),
  });

  const pkg = {
    name: PACKAGE_NAME,
    version,
    description: repoPkg.description,
    license: 'SEE LICENSE IN LICENSE',
    author: repoPkg.author,
    type: 'module',
    homepage: repoPkg.homepage,
    repository: repoPkg.repository,
    bugs: repoPkg.bugs,
    keywords: repoPkg.keywords,
    publishConfig: {
      access: 'public',
      registry: DEFAULT_REGISTRY,
    },
    files: [
      'cordis.patch.yml',
      'bin/dexsql.mjs',
      'vendor/**',
      'README.md',
      'CHANGELOG.md',
      'LICENSE',
      'LICENSE-AUXILIARY',
      'LICENSE-WRAPPER',
      'locale/*.json',
    ],
    exports: repoPkg.exports,
    dsh: repoPkg.dsh,
    engines: repoPkg.engines,
    bin: { dexsql: 'bin/dexsql.mjs' },
    dexsql: {
      version: upstreamVersion,
      tag,
      source: releaseUrl,
    },
  };
  await writeJson(join(stageDir, 'package.json'), pkg);

  const manifest = {
    changed: true,
    name: PACKAGE_NAME,
    version,
    upstreamVersion,
    tag,
    source: SOURCE_URL,
    releaseUrl,
    checksums: sortedChecksums(checksums),
    packageDir: 'package',
  };
  await writeJson(join(safeOutDir, 'manifest.json'), manifest);
  return manifest;
}

async function writeUnchangedManifest({ outDir, version, upstreamVersion, tag, releaseUrl }) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const manifest = {
    changed: false,
    name: PACKAGE_NAME,
    version,
    upstreamVersion,
    tag,
    source: SOURCE_URL,
    releaseUrl,
  };
  await writeJson(join(outDir, 'manifest.json'), manifest);
  return manifest;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({
    args: argv,
    options: {
      tag: { type: 'string' },
      version: { type: 'string' },
      out: { type: 'string' },
      'api-base': { type: 'string' },
      registry: { type: 'string' },
      'keep-assets': { type: 'boolean' },
    },
    allowPositionals: false,
  });

  const apiBase = values['api-base'] ?? env.DEXSQL_GITHUB_API ?? DEFAULT_API_BASE;
  const registry = values.registry ?? env.DEXSQL_NPM_REGISTRY ?? DEFAULT_REGISTRY;
  const outDir = assertSafeOutputDir(values.out ?? DEFAULT_OUT);
  const token = env.GITHUB_TOKEN || env.GH_TOKEN || '';
  const assetsDir = await mkdtemp(join(tmpdir(), 'dexsql-assets-'));

  try {
    const release = validateRelease(await fetchJson(releaseApiUrl(apiBase, values.tag), { token }));
    let version = values.version;
    if (version) {
      parseSemver(version);
    } else {
      const repoPkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
      const packument = await fetchPackument(PACKAGE_NAME, { registry });
      const resolved = resolveVersion({
        repoVersion: repoPkg.version,
        packument,
        upstreamVersion: release.version,
      });
      if (resolved.skip) {
        const manifest = await writeUnchangedManifest({
          outDir,
          version: resolved.version,
          upstreamVersion: release.version,
          tag: release.tag,
          releaseUrl: release.htmlUrl,
        });
        console.log(`DexSQL ${release.tag} is already packaged as ${PACKAGE_NAME}@${resolved.version}`);
        return manifest;
      }
      version = resolved.version;
    }

    const checksums = await downloadRelease({ release, assetsDir });
    const manifest = await buildPackage({
      version,
      upstreamVersion: release.version,
      tag: release.tag,
      assetsDir,
      outDir,
      releaseUrl: release.htmlUrl,
      checksums,
    });
    console.log(`Packaged DexSQL ${release.tag} as ${PACKAGE_NAME}@${version} in ${outDir}/package`);
    return manifest;
  } finally {
    if (values['keep-assets']) {
      console.log(`Downloaded assets kept in ${assetsDir}`);
    } else {
      await rm(assetsDir, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`dexsql sync failed: ${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}
