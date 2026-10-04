const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('unified OpenAI route supports tools, models, SSE and removes old roots', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-proxy-test-'));
  const capture = path.join(tmp, 'requests.jsonl');
  const preload = path.join(tmp, 'preload.cjs');
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    require(${JSON.stringify(path.resolve('dist/services/auth.service.js'))}).getAuth = async () => ({ accessToken: 'test-only', subscriptionType: 'test', rateLimitTier: 'test' });
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
    env: { ...process.env, PORT: '0', API_KEY: 'test-only', DEFAULT_MODEL: 'claude-sonnet-4-6', TOOL_PROMPT_CACHE_TTL: '5m' }, stdio: ['ignore', 'pipe', 'pipe'],
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
    assert.equal((await post('/openai/v1/chat/completions', body, 'wrong')).status, 401);
    for (const path of ['/v1/models', '/tools/v1/models']) assert.equal((await fetch(url + path)).status, 404);
    for (const path of ['/v1/chat/completions', '/tools/v1/chat/completions']) assert.equal((await post(path, body)).status, 404);
    const native = await (await post('/openai/v1/chat/completions', body)).json();
    assert.equal(native.choices[0].finish_reason, 'tool_calls');
    assert.equal(native.choices[0].message.tool_calls[0].function.name, 'echo');
    const models = await (await fetch(url + '/openai/v1/models')).json();
    assert.ok(models.data.some(m => m.id === 'claude-sonnet-4-6'));
    for (const stream of [false, true]) {
      const response = await post('/openai/v1/chat/completions', { ...body, model: 'claude-sonnet-4-6-1m', stream });
      assert.equal(response.status, 200);
      const output = await response.text();
      assert.match(output, /claude-sonnet-4-6-1m/);
      const upstream = JSON.parse(fs.readFileSync(capture, 'utf8').trim().split('\n').at(-1));
      assert.equal(upstream.model, 'claude-sonnet-4-6');
      assert.equal(upstream.cache_control.ttl, '5m');
    }
    assert.equal((await fetch(url + '/health')).status, 200);
    const large = { ...body, messages: [{ role: 'user', content: 'x'.repeat(3 * 1024 * 1024) }] };
    assert.equal((await post('/openai/v1/chat/completions', large)).status, 200);
  } finally { child.kill(); await new Promise(resolve => child.once('exit', resolve)); fs.rmSync(tmp, { recursive: true, force: true }); }
});
