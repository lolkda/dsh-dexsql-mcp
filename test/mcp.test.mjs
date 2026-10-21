import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { test } from 'node:test';

const probe = spawnSync('dexsql', ['--version'], { encoding: 'utf8' });
const hasDexsql = probe.status === 0;

test('dexsql mcp answers initialize and tools/list', { skip: !hasDexsql && 'dexsql is not on PATH', timeout: 20_000 }, async (t) => {
  const child = spawn('dexsql', ['mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => {
    if (!child.killed) child.kill('SIGTERM');
  });

  let buffer = '';
  let nextId = 1;
  const pending = new Map();

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timed out waiting for ${method}`));
    }, 10_000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    send({ jsonrpc: '2.0', id, method, params });
  });

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    }
  });

  child.on('error', (error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });

  const initialized = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'dsh-dexsql-mcp-test', version: '0.1.0' },
  });
  assert.equal(initialized.serverInfo?.name, 'dexsql');
  assert.ok(initialized.protocolVersion);

  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const listed = await request('tools/list', {});
  const names = listed.tools.map((tool) => tool.name);
  assert.ok(names.includes('open_dataset'));
  assert.ok(names.includes('query'));
  assert.ok(names.includes('list_datasets'));
  assert.equal(names.length, 12);
});
