#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const targets = {
  'darwin-x64': ['darwin-x64', 'dexsql'],
  'darwin-arm64': ['darwin-arm64', 'dexsql'],
  'linux-x64': ['linux-x64', 'dexsql'],
  'linux-arm64': ['linux-arm64', 'dexsql'],
  'win32-x64': ['win32-x64', 'dexsql.exe'],
  'win32-arm64': ['win32-arm64', 'dexsql.exe'],
};

const key = `${process.platform}-${process.arch}`;
const target = targets[key];
if (!target) {
  console.error(
    `dexsql does not provide a binary for ${process.platform}/${process.arch}. `
    + `Supported targets: ${Object.keys(targets).join(', ')}.`,
  );
  process.exit(1);
}

const [platformDir, binaryName] = target;
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const binary = join(packageRoot, 'vendor', platformDir, binaryName);
if (!existsSync(binary)) {
  console.error(
    `The bundled binary is missing: ${binary}. `
    + 'Reinstall @lolkda/dsh-dexsql-mcp and restart the DSH profile.',
  );
  process.exit(1);
}

const child = spawn(binary, process.argv.slice(2), { stdio: 'inherit' });
let forwardedSignal;

function forwardSignal(signal) {
  if (forwardedSignal) return;
  forwardedSignal = signal;
  try {
    child.kill(signal);
  } catch {
    // The child may already have exited.
  }
  const timer = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // The child may already have exited.
    }
    process.exit(1);
  }, 750);
  timer.unref();
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => forwardSignal(signal));
}

child.on('error', (error) => {
  console.error(`failed to start ${binary}: ${error.message}`);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
