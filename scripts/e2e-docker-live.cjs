#!/usr/bin/env node
'use strict';
// Explicit opt-in. Copies credentials outside build context; never prints their contents.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
if (process.env.E2E_ALLOW_REAL_INFERENCE !== '1') {
  console.error('Set E2E_ALLOW_REAL_INFERENCE=1 to authorize real provider requests.');
  process.exit(2);
}
const root = path.resolve(__dirname, '..');
const name = `hermes-claude-e2e-${Date.now()}`;
const image = name;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-claude-e2e-'));
fs.chmodSync(dir, 0o700);
const credentialsSource = path.resolve(process.env.CLAUDE_CREDENTIALS_SOURCE || path.join(os.homedir(), '.claude/.credentials.json'));
const credentials = JSON.parse(fs.readFileSync(credentialsSource, 'utf8'));
const oauth = credentials.claudeAiOauth;
if (!oauth?.accessToken || !oauth?.refreshToken || !oauth?.expiresAt) throw new Error('Usable Claude Code OAuth copy not found');
fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({
  type: 'oauth', access: oauth.accessToken, refresh: oauth.refreshToken,
  expires: oauth.expiresAt, scopes: oauth.scopes || [],
}));
fs.copyFileSync(credentialsSource, path.join(dir, '.credentials.json'));
for (const target of ['auth.json', '.credentials.json']) fs.chmodSync(path.join(dir, target), 0o600);
const docker = args => execFileSync('docker', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const key = require('node:crypto').randomBytes(24).toString('hex');
(async () => {
  docker(['build', '-t', image, root]);
  docker(['run', '-d', '--name', name, '-p', '127.0.0.1::4181', '-e', `API_KEY=${key}`, '-e', 'CLAUDE_PROXY_HOME=/credentials', '-e', 'CLAUDE_CONFIG_DIR=/credentials', '-v', `${dir}:/credentials:ro`, '-v', `${root}/data:/app/data:ro`, image]);
  const binding = docker(['port', name, '4181/tcp']);
  const baseURL = `http://${binding}`;
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { ready = (await fetch(`${baseURL}/health`)).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error('Container health did not become ready');
  console.log(JSON.stringify({ container: name, image, baseURL, credentialCopies: dir }));
  const { runCases } = require('../tests/e2e-cases.cjs');
  console.log(JSON.stringify(await runCases({ baseURL, apiKey: key, report: result => console.log(JSON.stringify(result)) })));
})().catch(error => {
  // Docker startup diagnostics do not contain auth-file contents.
  console.error(error.stderr?.toString() || error.message);
  console.error(JSON.stringify({ container: name, image, credentialCopies: dir, status: 'failed', retained: true }));
  process.exitCode = 1;
});
