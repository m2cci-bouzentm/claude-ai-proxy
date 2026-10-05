#!/usr/bin/env node
'use strict';
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const name = `hermes-claude-regression-${process.pid}-${Date.now()}`;
const image = `${name}:local`;
const docker = (...args) => execFileSync('docker', args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
(async () => {
  try {
    console.log(docker('build', '-t', image, root));
    docker('run', '-d', '--name', name, '--network', 'none', '-e', 'API_KEY=regression-inbound-only', '-e', 'SYSTEM_PROMPT_PATH=/app/mock-prompt.json', '-e', 'NODE_OPTIONS=--require=/app/provider-mock.cjs', '--mount', `type=bind,src=${path.join(root, 'tests/provider-mock.cjs')},dst=/app/provider-mock.cjs,readonly`, '--mount', `type=bind,src=${path.join(root, 'tests/regression-prompt.json')},dst=/app/mock-prompt.json,readonly`, image);
    // --network none makes external inference impossible. Use Docker exec for loopback HTTP client.
    docker('cp', path.join(root, 'tests/e2e-cases.cjs'), `${name}:/app/e2e-cases.cjs`);
    const client = `const {runCases}=require('/app/e2e-cases.cjs'); (async()=>{ for(let i=0;i<100;i++){try{await fetch('http://127.0.0.1:4181/health');break;}catch{await new Promise(r=>setTimeout(r,100));}} console.log(JSON.stringify(await runCases({baseURL:'http://127.0.0.1:4181',apiKey:'regression-inbound-only',report:x=>console.log(JSON.stringify(x))}))); })().catch(e=>{console.error(e);process.exitCode=1});`;
    console.log(docker('exec', '-e', 'NODE_OPTIONS=', name, 'node', '-e', client));
    const captures = docker('exec', name, 'node', '-e', "process.stdout.write(require('fs').readFileSync('/tmp/provider-captures.jsonl','utf8'))").trim().split('\n').map(JSON.parse);
    assert.ok(captures.some(c => JSON.stringify(c.body.messages || []).includes('"type":"image"')), 'provider image forwarding missing');
    assert.ok(captures.some(c => JSON.stringify(c.body.messages || []).includes('"type":"tool_result"')), 'provider tool result forwarding missing');
    assert.ok(captures.filter(c => c.path === '/v1/messages' && c.session === 'http-e2e-stable-session').length >= 3, 'native stable session forwarding missing');
    const ocCapture = captures.find(c => c.body?.tools?.some(t => t.name === 'read'));
    assert.ok(ocCapture, 'OpenCode read tool request missing in docker regression');
    assert.deepEqual(ocCapture.body.tools.map(t => t.name), ['read', 'edit', 'write']);
    assert.equal(ocCapture.body.system[0].text, 'Regression-only trusted prompt.');
    assert.equal(ocCapture.body.system[1].text, '[system]\nOpenCode system authority prompt.');
    assert.equal(ocCapture.body.system[2].text, '[developer]\nOpenCode developer guidance instructions.');
    assert.ok(captures.some(c => c.body?.model === 'claude-haiku-4-5-20251001'), 'client model switch to haiku missing in docker regression');
    assert.ok(captures.some(c => c.body?.model === 'claude-sonnet-4-6'), 'client model switch to sonnet missing in docker regression');
    console.log(`PASS: 11 public routes, multimodal/tools/SSE, repeated provider cache counters; ${captures.length} provider captures; external network disabled`);
  } finally {
    try { docker('rm', '-f', name); } catch {}
    try { docker('image', 'rm', image); } catch {}
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
