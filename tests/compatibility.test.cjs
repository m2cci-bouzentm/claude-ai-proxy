const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('real server preserves legacy JSON/SSE/auth/models while new endpoint uses native tools', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-proxy-test-'));
  const capture = path.join(tmp, 'requests.jsonl');
  const preload = path.join(tmp, 'preload.cjs');
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    require(${JSON.stringify(path.resolve('dist/auth.js'))}).getAuth = async () => ({ accessToken: 'test-only', subscriptionType: 'test', rateLimitTier: 'test' });
    global.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify(body) + '\\n');
      const tools = !!body.tools;
      const block = tools ? { type: 'tool_use', id: 'toolu_test', name: 'echo', input: {} } : { type: 'text', text: '' };
      const events = [
        { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 2, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: block },
        { type: 'content_block_delta', index: 0, delta: tools ? { type: 'input_json_delta', partial_json: '{"text":"ok"}' } : { type: 'text_delta', text: 'LEGACY_OK' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: tools ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 3 } },
        { type: 'message_stop' }
      ];
      return new Response(events.map(e => 'event: ' + e.type + '\\ndata: ' + JSON.stringify(e) + '\\n\\n').join(''), { headers: { 'Content-Type': 'text/event-stream' } });
    };
    const net = require('node:net');
    const original = net.Server.prototype.listen;
    net.Server.prototype.listen = function (...args) {
      this.once('listening', () => console.log('TEST_PORT=' + this.address().port));
      return original.apply(this, args);
    };
  `);
  const child = spawn(process.execPath, ['--require', preload, 'dist/index.js'], {
    env: { ...process.env, PORT: '0', API_KEY: 'test-only', DEFAULT_MODEL: 'claude-sonnet-4-6' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server startup timeout')), 5000);
      child.stdout.on('data', data => { const m = String(data).match(/TEST_PORT=(\d+)/); if (m) { clearTimeout(timer); resolve(m[1]); } });
      child.once('exit', code => { clearTimeout(timer); reject(new Error('Server exited: ' + code)); });
    });
    const url = `http://127.0.0.1:${port}`;
    const body = { messages: [{ role: 'system', content: 'client instructions' }, { role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'echo', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } }], tool_choice: 'required' };
    const post = (route, input, key = 'test-only') => fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify(input) });
    for (const route of ['/v1/chat/completions', '/tools/v1/chat/completions']) assert.equal((await post(route, body, 'wrong')).status, 401);
    const legacy = await (await post('/v1/chat/completions', body)).json();
    assert.deepEqual(legacy.choices, [{ index: 0, message: { role: 'assistant', content: 'LEGACY_OK' }, finish_reason: 'stop' }]);
    assert.deepEqual(legacy.usage, { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 });
    const oldStream = await (await post('/v1/chat/completions', { ...body, stream: true })).text();
    assert.match(oldStream, /LEGACY_OK/); assert.match(oldStream, /data: \[DONE\]/);
    const native = await (await post('/tools/v1/chat/completions', body)).json();
    assert.equal(native.choices[0].message.tool_calls[0].function.name, 'echo');
    const requests = fs.readFileSync(capture, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(requests[0].tools, undefined); assert.deepEqual(requests[0].thinking, { type: 'adaptive' });
    assert.deepEqual(requests[0].messages, [{ role: 'user', content: 'hi' }]);
    assert.equal(requests[2].tools[0].name, 'echo'); assert.equal(requests[2].thinking, undefined);
    assert.equal(requests[2].system.at(-1).text, 'client instructions');
    const oldBilling = requests[0].system.find(b => b.text?.startsWith('x-anthropic-billing-header:')).text;
    assert.match(oldBilling, /cc_version=2\.1\.160/);
    assert.match(requests[2].system.find(b => b.text?.startsWith('x-anthropic-billing-header:')).text, /cc_version=2\.1\.251/);
    assert.deepEqual(await (await fetch(url + '/v1/models')).json(), await (await fetch(url + '/tools/v1/models')).json());
    assert.equal((await (await post('/v1/chat/completions', {})).json()).error.message, 'messages is required');
    const large = { ...body, messages: [{ role: 'user', content: 'x'.repeat(3 * 1024 * 1024) }] };
    assert.equal((await post('/v1/chat/completions', large)).status, 413);
    assert.equal((await post('/tools/v1/chat/completions', large)).status, 200);
  } finally { child.kill(); await new Promise(resolve => child.once('exit', resolve)); fs.rmSync(tmp, { recursive: true, force: true }); }
});
