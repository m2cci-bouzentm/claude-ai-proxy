#!/usr/bin/env node
'use strict';
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');

const root = path.resolve(__dirname, '..');
const volumeName = `test-claude-vol-${process.pid}-${Date.now()}`;
const imageName = `test-claude-img-${process.pid}-${Date.now()}`;

const docker = (...args) => execFileSync('docker', args, { cwd: root, encoding: 'utf8' });

(async () => {
  try {
    console.log('Building Docker image...');
    docker('build', '-t', imageName, root);

    console.log('Creating volume for persistent auth...');
    docker('volume', 'create', volumeName);

    // 1. Initial status in container -> unconfigured
    const initialStatusRaw = docker('run', '--rm', '-v', `${volumeName}:/data`, imageName, 'proxy-auth', 'status');
    const initialStatus = JSON.parse(initialStatusRaw);
    assert.equal(initialStatus.configured, false);

    // 2. Import valid synthetic auth via stdin
    const syntheticAuth = {
      type: 'oauth',
      access: 'sk-ant-docker-test-access-token',
      refresh: 'sk-ant-docker-test-refresh-token',
      expires: Date.now() + 3600000,
      subscriptionType: 'pro'
    };

    const importResRaw = execFileSync('docker', [
      'run', '--rm', '-i',
      '-v', `${volumeName}:/data`,
      imageName,
      'proxy-auth', 'import', '-'
    ], { input: JSON.stringify(syntheticAuth), encoding: 'utf8' });

    const importRes = JSON.parse(importResRaw);
    assert.equal(importRes.success, true);
    assert.equal(importRes.configured, true);
    assert.equal(importRes.subscriptionType, 'pro');
    assert.equal(importResRaw.includes('sk-ant-docker-test-access-token'), false);
    assert.equal(importResRaw.includes('sk-ant-docker-test-refresh-token'), false);

    // 3. Status in container -> configured, no tokens exposed
    const afterStatusRaw = docker('run', '--rm', '-v', `${volumeName}:/data`, imageName, 'proxy-auth', 'status');
    const afterStatus = JSON.parse(afterStatusRaw);
    assert.equal(afterStatus.configured, true);
    assert.equal(afterStatus.type, 'oauth');
    assert.equal(afterStatus.access, undefined);
    assert.equal(afterStatus.refresh, undefined);
    assert.equal(afterStatusRaw.includes('sk-ant-docker-test-access-token'), false);

    // 4. Test entrypoint wrapper shorthand: "status" without "proxy-auth"
    const shorthandStatusRaw = docker('run', '--rm', '-v', `${volumeName}:/data`, imageName, 'status');
    const shorthandStatus = JSON.parse(shorthandStatusRaw);
    assert.equal(shorthandStatus.configured, true);

    console.log('PASS: Docker integration test with persistent volume and proxy-auth CLI succeeded');
  } finally {
    try { docker('volume', 'rm', '-f', volumeName); } catch {}
    try { docker('image', 'rm', '-f', imageName); } catch {}
  }
})().catch(err => {
  console.error('Docker test failed:', err);
  process.exitCode = 1;
});
