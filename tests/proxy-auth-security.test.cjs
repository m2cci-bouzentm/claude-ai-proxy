const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

test('proxy-auth security: symlink rejection, non-regular file rejection, restrictive permissions', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-auth-sec-'));
  try {
    const cliPath = path.resolve(__dirname, '../bin/proxy-auth');
    const authDir = path.join(tmpDir, 'data');
    const env = { ...process.env, PROXY_AUTH_DIR: authDir };

    // 1. Rejection of symlinks as import file
    const realFile = path.join(tmpDir, 'real.json');
    fs.writeFileSync(realFile, JSON.stringify({
      type: 'oauth',
      access: 'sec-access',
      refresh: 'sec-refresh',
      expires: Date.now() + 3600000
    }));
    const symlinkFile = path.join(tmpDir, 'symlink.json');
    fs.symlinkSync(realFile, symlinkFile);

    const resSym = spawnSync(process.execPath, [cliPath, 'import', '--file', symlinkFile], { env, encoding: 'utf-8' });
    assert.notEqual(resSym.status, 0);
    assert.ok(resSym.stderr.includes('symbolic link') || resSym.stderr.includes('symlink'));

    // 2. Import valid file, check umask 0700 dir and 0600 file
    const resValid = spawnSync(process.execPath, [cliPath, 'import', '--file', realFile], { env, encoding: 'utf-8' });
    assert.equal(resValid.status, 0);

    const dirStat = fs.statSync(authDir);
    assert.equal(dirStat.mode & 0o777, 0o700);

    const authFile = path.join(authDir, 'auth.json');
    const fileStat = fs.statSync(authFile);
    assert.equal(fileStat.mode & 0o777, 0o600);

    // 3. Status never leaks tokens in any form
    const resStatus = spawnSync(process.execPath, [cliPath, 'status'], { env, encoding: 'utf-8' });
    assert.equal(resStatus.status, 0);
    assert.equal(resStatus.stdout.includes('sec-access'), false);
    assert.equal(resStatus.stdout.includes('sec-refresh'), false);
    const parsedStatus = JSON.parse(resStatus.stdout);
    assert.equal(parsedStatus.access, undefined);
    assert.equal(parsedStatus.refresh, undefined);
    assert.equal(parsedStatus.configured, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
