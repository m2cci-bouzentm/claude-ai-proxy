'use strict';
const { test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { runCases } = require('./e2e-cases.cjs');

test('shared 11-route HTTP integration with regression-only mocked provider', async () => {
  const root = path.resolve(__dirname, '..');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-http-regression-'));
  const capture = path.join(temporary, 'captures.jsonl');
  const net = require('node:net');
  const listener = net.createServer(); await new Promise(r => listener.listen(0, '127.0.0.1', r));
  const port = listener.address().port; await new Promise(r => listener.close(r));
  const server = spawn(process.execPath, ['--require', path.join(__dirname, 'provider-mock.cjs'), path.join(root, 'dist/index.js')], { cwd: temporary, env: { PATH: process.env.PATH, HOME: temporary, API_KEY: 'regression-inbound-only', PORT: String(port), SYSTEM_PROMPT_PATH: path.join(__dirname, 'regression-prompt.json'), REGRESSION_CAPTURE: capture } });
  let output = ''; server.stdout.on('data', c => { output += c; }); server.stderr.on('data', c => { output += c; });
  try {
    const baseURL = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 100; i++) { try { ready = (await fetch(baseURL + '/health')).ok; if (ready) break; } catch {} await new Promise(r => setTimeout(r, 20)); }
    assert.ok(ready, output);
    const result = await runCases({ baseURL, apiKey: 'regression-inbound-only' }); assert.equal(result.count, 11);
    const captures = fs.readFileSync(capture, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(captures.some(c => JSON.stringify(c.body.messages || []).includes('"type":"image"')));
    assert.ok(captures.some(c => JSON.stringify(c.body.messages || []).includes('"type":"tool_result"')));
    assert.ok(captures.filter(c => c.session === 'http-e2e-stable-session').length >= 3);
    const ocCapture = captures.find(c => c.body?.tools?.some(t => t.name === 'read'));
    assert.ok(ocCapture, 'OpenCode read tool request must reach upstream');
    assert.deepEqual(ocCapture.body.tools.map(t => t.name), ['read', 'edit', 'write']);
    assert.equal(ocCapture.body.system[0].text, 'Regression-only trusted prompt.');
    assert.equal(ocCapture.body.system[1].text, '[system]\nOpenCode system authority prompt.');
    assert.equal(ocCapture.body.system[2].text, '[developer]\nOpenCode developer guidance instructions.');
    assert.ok(captures.some(c => c.body?.model === 'claude-haiku-4-5-20251001'), 'exact client model switch to haiku reaches upstream');
    assert.ok(captures.some(c => c.body?.model === 'claude-sonnet-4-6'), 'exact client model switch to sonnet reaches upstream');
  } finally { server.kill(); await new Promise(r => server.once('exit', r)); fs.rmSync(temporary, { recursive: true, force: true }); }
});
