const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

// Intercept before Vite imports fs. Never open or read the credential mount.
const probe = `
  import fs from 'node:fs';
  import path from 'node:path';
  import { createRequire, syncBuiltinESMExports } from 'node:module';
  import { pathToFileURL, fileURLToPath } from 'node:url';
  const root = process.cwd();
  const accesses = [];
  const stat = fs.statSync;
  // Present a synthetic FIFO to the real loader, even on hosts without a mount.
  fs.statSync = function(file, ...args) {
    if (file === path.join(root, '.env')) return { isFile: () => false, isFIFO: () => true };
    return stat.call(this, file, ...args);
  };
  const original = fs.readFileSync;
  fs.readFileSync = function(file, ...args) {
    const name = file instanceof URL ? fileURLToPath(file) : Buffer.isBuffer(file) ? file.toString() : file;
    if (typeof name === 'string' && /^\\.env(?:\\.|$)/.test(path.basename(name)) && path.dirname(path.resolve(name)) === root) {
      accesses.push({ operation: 'readFileSync', path: path.relative(root, name) });
      throw new Error('CREDENTIAL_READ_BLOCKED');
    }
    return original.call(this, file, ...args);
  };
  syncBuiltinESMExports();
  const require = createRequire(import.meta.url);
  const viteRequire = createRequire(require.resolve('vitest/package.json'));
  const { resolveConfig } = await import(pathToFileURL(viteRequire.resolve('vite')).href);
  const control = process.argv[1] === 'control';
  let resolved, failure;
  try {
    resolved = await resolveConfig({ configFile: path.join(root, 'vitest.config.ts'), logLevel: 'silent', ...(control ? { envDir: root } : {}) }, 'serve', 'test');
  } catch (error) { failure = error.message; }
  process.stdout.write(JSON.stringify({ control, envDir: resolved?.envDir, accesses, failure }));
`;

function inspect(mode) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe, mode], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 30000
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('actual default Vitest configuration disables Vite credential file loading', () => {
  const result = inspect('default');
  assert.equal(result.failure, undefined);
  assert.equal(result.envDir, false);
  assert.deepEqual(result.accesses, []);
});

test('enabling the same Vite loader attempts a read that instrumentation blocks', () => {
  const result = inspect('control');
  assert.equal(result.failure, 'CREDENTIAL_READ_BLOCKED');
  assert.deepEqual(result.accesses, [{ operation: 'readFileSync', path: '.env' }]);
});
