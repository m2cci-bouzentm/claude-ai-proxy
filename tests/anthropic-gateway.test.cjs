const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
process.env.API_KEY = 'inbound-test-key';
const auth = require('../dist/services/auth.service');
auth.getAuth = async () => ({ accessToken: 'server-oauth-test-token' });

test('native gateway authenticates, preserves request, replaces credentials, streams and cancels', async () => {
  const captures = [];
  let release, disconnected;
  const disconnect = new Promise(r => { disconnected = r; });
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); captures.push({ headers: req.headers, body });
    if (body.model === 'slow') return;
    if (body.model === 'redirect') { res.writeHead(307, { location: '/redirect-target' }); return res.end(); }
    if (body.model === 'broken') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      setTimeout(() => res.destroy(), 25); return;
    }
    if (body.model === 'oversize') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('x'.repeat(33 * 1024 * 1024)); }
    if (body.model === 'error') {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3', 'request-id': 'req_test' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'retry later' } }));
    }
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      res.on('close', disconnected);
      await new Promise(r => { release = r; });
      return res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'ok' }] }));
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  process.env.ANTHROPIC_UPSTREAM_URL = `http://127.0.0.1:${upstream.address().port}/v1/messages`;
  const { createAnthropicRouter } = require('../dist/routes/anthropic');
  const { authenticateAnthropic: authenticate } = require('../dist/middleware/auth');
  const app = express(); app.use(express.json()); app.use('/anthropic/v1', authenticate, createAnthropicRouter());
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/anthropic/v1/messages`;
  const body = { model: 'claude-sonnet-4-6', max_tokens: 100, messages: [{ role: 'user', content: 'hello' }], system: [{ type: 'text', text: 'client system', cache_control: { type: 'ephemeral' } }], thinking: { type: 'adaptive' }, tools: [{ name: 'echo', input_schema: { type: 'object' } }], metadata: { user_id: 'client-session' }, output_config: { effort: 'high' } };
  const post = (value, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'inbound-test-key', ...headers }, body: JSON.stringify(value) });
  try {
    assert.equal((await post(body, { 'x-api-key': 'wrong' })).status, 401); assert.equal(captures.length, 0);
    const response = await post(body, { 'anthropic-beta': 'custom-beta,oauth-2025-04-20', 'anthropic-version': '2023-06-01', 'x-stainless-retry-count': '2' });
    assert.equal(response.status, 200); assert.equal((await response.json()).content[0].text, 'ok');
    assert.deepEqual(captures[0].body, body);
    assert.equal(captures[0].headers.authorization, 'Bearer server-oauth-test-token');
    assert.equal(captures[0].headers['x-api-key'], undefined);
    assert.ok(captures[0].headers['anthropic-beta'].includes('custom-beta'));
    assert.equal(captures[0].headers['x-stainless-retry-count'], '2');
    const error = await post({ ...body, model: 'error' }); assert.equal(error.status, 429);
    assert.equal(error.headers.get('retry-after'), '3'); assert.equal(error.headers.get('request-id'), 'req_test');
    assert.equal((await error.json()).error.type, 'rate_limit_error');
    const redirect = await post({ ...body, model: 'redirect' });
    assert.equal(redirect.status, 502);
    const broken = await post({ ...body, model: 'broken', stream: true });
    assert.match(await broken.text(), /event: error/);
    const oversize = await post({ ...body, model: 'oversize' });
    assert.equal(oversize.status, 502);
    const controller = new AbortController();
    const stream = await fetch(url, { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json', authorization: 'Bearer inbound-test-key' }, body: JSON.stringify({ ...body, stream: true }) });
    const reader = stream.body.getReader();
    const first = await reader.read(); assert.match(Buffer.from(first.value).toString(), /message_start/);
    controller.abort(); await Promise.race([disconnect, new Promise((_, reject) => setTimeout(() => reject(Error('upstream not aborted')), 1000))]);
    release();
    process.env.ANTHROPIC_TIMEOUT_MS = '50';
    const timeout = await post({ ...body, model: 'slow' });
    assert.equal(timeout.status, 504);
    delete process.env.ANTHROPIC_TIMEOUT_MS;
    auth.getAuth = async () => { throw Error('server-oauth-test-token inbound-test-key'); };
    const failure = await post(body); assert.equal(failure.status, 502);
    assert.doesNotMatch(await failure.text(), /server-oauth-test-token|inbound-test-key/);
  } finally {
    release?.(); server.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(r => server.close(r)), new Promise(r => upstream.close(r))]);
  }
});
