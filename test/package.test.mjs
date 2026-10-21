import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json'));
const patch = parse(read('cordis.patch.yml'));
const row = patch
  .flatMap((layer) => layer.insert ?? [])
  .find((entry) => entry.id === 'dexsql-mcp');

test('package is a publishable DSH configuration bundle', () => {
  assert.equal(pkg.name, '@lolkda/dsh-dexsql-mcp');
  assert.equal(pkg.version, '0.1.0');
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.equal(pkg.publishConfig?.access, 'public');
  assert.equal(pkg.engines?.dsh, '>=0.2.1-rc.2 <0.3.0');
  assert.match(pkg.repository?.url ?? '', /^git\+https:\/\/github\.com\/lolkda\/dsh-dexsql-mcp\.git$/);
});

test('published files include the patch and plugin metadata', () => {
  for (const file of ['cordis.patch.yml', 'README.md', 'LICENSE', 'icon.svg', 'locale/en.json', 'locale/zh.json']) {
    assert.ok(pkg.files.includes(file) || pkg.files.some((entry) => entry.endsWith('/*.json')), `missing ${file}`);
  }
});

test('patch inserts the official MCP Host plugin', () => {
  assert.ok(row, 'dexsql-mcp row is missing');
  assert.equal(row.name, '@deepseek-ai/dsh-mcp-client');
  assert.equal(row.config?.serverName, 'dexsql');
  assert.equal(row.config?.transport, 'stdio');
  assert.equal(row.config?.command, 'dexsql');
  assert.deepEqual(row.config?.args, ['mcp', '--timeout-ms', '300000']);
  assert.equal(row.config?.failOnStartupError, true);
  assert.equal(row.config?.toolCallTimeoutMs, 300000);
  assert.equal('cwd' in row.config, false);
});

test('patch does not hard-code an image-only binary path', () => {
  assert.doesNotMatch(read('cordis.patch.yml'), /\/usr\/local\/bin\/dexsql/);
});

test('locale and icon resources are valid', () => {
  const en = JSON.parse(read('locale/en.json'));
  const zh = JSON.parse(read('locale/zh.json'));
  assert.equal(en.meta?.title, 'DexSQL MCP');
  assert.equal(zh.meta?.title, 'DexSQL MCP');
  assert.ok(en.meta?.description);
  assert.ok(zh.meta?.description);
  assert.match(read('icon.svg'), /^<svg[\s\S]*<\/svg>\s*$/);
});

test('npm pack contains the bundle files and no DexSQL binary', () => {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [pack] = JSON.parse(output);
  const files = pack.files.map((file) => file.path);

  for (const expected of ['package.json', 'cordis.patch.yml', 'README.md', 'LICENSE', 'icon.svg', 'locale/en.json', 'locale/zh.json']) {
    assert.ok(files.includes(expected), `${expected} is missing from npm pack`);
  }
  assert.ok(!files.includes('dexsql'), 'the DexSQL binary must not be published');
});
