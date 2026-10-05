'use strict';
const assert = require('node:assert/strict');
const MODEL = 'claude-sonnet-4-6';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
function assertUsage(value, protocol, cached = false) {
  const u = value?.usage;
  assert.ok(u, `${protocol}: usage missing`);
  const input = protocol === 'openai' ? u.prompt_tokens : u.input_tokens;
  const output = protocol === 'openai' ? u.completion_tokens : u.output_tokens;
  assert.ok(Number.isFinite(input) && input > 0, `${protocol}: input usage missing/zero`);
  assert.ok(Number.isFinite(output) && output > 0, `${protocol}: output usage missing/zero`);
  if (cached) {
    const n = protocol === 'openai' ? u.prompt_tokens_details?.cached_tokens : u.cache_read_input_tokens;
    assert.ok(Number.isFinite(n) && n > 0, `${protocol}: cache usage missing/zero`);
  }
}
function parseSSE(text) {
  return text.split(/\r?\n/).filter(l => l.startsWith('data: ') && l !== 'data: [DONE]').map(l => JSON.parse(l.slice(6)));
}
async function runCases({ baseURL, apiKey, model = MODEL, session = 'http-e2e-stable-session', report = () => {} }) {
  const routes = new Set();
  async function request(path, body, method = body ? 'POST' : 'GET') {
    routes.add(`${method} ${path}`);
    const response = await fetch(baseURL.replace(/\/$/, '') + path, { method, headers: { authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey, 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-claude-code-session-id': session }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120000) });
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${await (!response.ok ? response.text() : Promise.resolve(''))}`);
    return response;
  }
  assert.equal((await request('/health')).status, 200);
  const models = await (await request('/openai/v1/models')).json(); assert.ok(models.data.some(m => m.id === model));
  const nativeModels = await (await request('/anthropic/v1/models')).json(); assert.ok(nativeModels.data.length > 0);
  assert.equal((await (await request(`/anthropic/v1/models/${model}`)).json()).id, model);
  const usage = await (await request('/anthropic/api/oauth/usage')).json(); assert.ok(usage.five_hour && Number.isFinite(usage.five_hour.utilization), 'OAuth usage missing');
  const profile = await (await request('/anthropic/api/oauth/profile')).json(); assert.ok(profile && Object.keys(profile).length > 0, 'profile missing');
  assert.equal((await request('/anthropic/api/hello', undefined, 'HEAD')).status, 200);
  const openai = messages => ({ model, max_tokens: 256, messages });
  const anthropic = messages => ({ model, max_tokens: 256, messages });
  const text = 'Reply with HTTP_E2E_OK only.';
  const basic = [{ role: 'user', content: text }];
  assertUsage(await (await request('/openai/v1/chat/completions', openai(basic))).json(), 'openai');
  assertUsage(await (await request('/anthropic/v1/messages', anthropic(basic))).json(), 'anthropic');
  const count = await (await request('/anthropic/v1/messages/count_tokens', { model, messages: basic })).json(); assert.ok(count.input_tokens > 0);
  await request('/anthropic/v1/messages/cache_touch', { model, messages: basic });
  for (const protocol of ['openai', 'anthropic']) {
    const path = protocol === 'openai' ? '/openai/v1/chat/completions' : '/anthropic/v1/messages';
    const body = protocol === 'openai' ? openai(basic) : anthropic(basic);
    const response = await request(path, { ...body, stream: true, ...(protocol === 'openai' ? { stream_options: { include_usage: true } } : {}) });
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const raw = await response.text(); const events = parseSSE(raw);
    assert.doesNotMatch(raw, /event: error/);
    if (protocol === 'openai') { assert.match(raw, /\[DONE\]/); assert.ok(events.some(e => e.choices?.[0]?.delta?.content)); assertUsage(events.find(e => e.usage), protocol); }
    else { assert.ok(events.some(e => e.type === 'content_block_delta' && e.delta.type === 'text_delta')); assert.ok(events.some(e => e.type === 'message_stop')); const start = events.find(e => e.type === 'message_start'); const delta = events.find(e => e.type === 'message_delta'); assertUsage({ usage: { ...start?.message?.usage, ...delta?.usage } }, protocol); }
    const image = protocol === 'openai' ? [{ type: 'text', text: 'Describe this image briefly.' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }] : [{ type: 'text', text: 'Describe this image briefly.' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }];
    assertUsage(await (await request(path, { ...body, messages: [{ role: 'user', content: image }] })).json(), protocol);
    const schema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false };
    const tools = protocol === 'openai' ? [{ type: 'function', function: { name: 'echo', description: 'Echo text', parameters: schema } }] : [{ name: 'echo', description: 'Echo text', input_schema: schema }];
    const choice = protocol === 'openai' ? { type: 'function', function: { name: 'echo' } } : { type: 'tool', name: 'echo' };
    const toolRequest = { ...body, messages: [{ role: 'user', content: 'Call echo with text HTTP_E2E_OK.' }], tools, tool_choice: choice };
    const called = await (await request(path, toolRequest)).json(); assertUsage(called, protocol);
    let history;
    if (protocol === 'openai') { const call = called.choices[0].message.tool_calls[0]; assert.equal(call.function.name, 'echo'); assert.equal(typeof JSON.parse(call.function.arguments).text, 'string'); history = [...toolRequest.messages, called.choices[0].message, { role: 'tool', tool_call_id: call.id, content: 'HTTP_E2E_OK' }]; }
    else { const call = called.content.find(c => c.type === 'tool_use'); assert.equal(call.name, 'echo'); assert.equal(typeof call.input.text, 'string'); history = [...toolRequest.messages, { role: 'assistant', content: called.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'HTTP_E2E_OK' }] }]; }
    assertUsage(await (await request(path, { ...body, messages: history, tools })).json(), protocol);
    const streamedTool = parseSSE(await (await request(path, { ...toolRequest, stream: true })).text());
    if (protocol === 'openai') { const chunks = streamedTool.flatMap(e => e.choices?.[0]?.delta?.tool_calls || []); assert.ok(chunks.some(c => c.function?.name === 'echo')); assert.equal(typeof JSON.parse(chunks.map(c => c.function?.arguments || '').join('')).text, 'string'); }
    else { assert.ok(streamedTool.some(e => e.content_block?.type === 'tool_use')); const json = streamedTool.filter(e => e.delta?.type === 'input_json_delta').map(e => e.delta.partial_json).join(''); assert.equal(typeof JSON.parse(json).text, 'string'); }
    // >1,024-token prefix: repeated exact requests in same session must expose provider cache counters.
    const prefix = 'Reference facts: alpha beta gamma delta epsilon zeta eta theta.\n'.repeat(600);
    const messages = [{ role: 'user', content: `${prefix}\nReply HTTP_E2E_OK.` }];
    const cacheBody = { ...body, messages, ...(protocol === 'anthropic' ? { cache_control: { type: 'ephemeral' } } : {}) };
    assertUsage(await (await request(path, cacheBody)).json(), protocol);
    for (let repeat = 0; repeat < 2; repeat++) { const result = await (await request(path, cacheBody)).json(); assertUsage(result, protocol, true); report({ protocol, repeat, usage: result.usage }); }
  }
  assert.equal(routes.size, 11, 'all 11 public routes exercised');
  return { routes: [...routes], count: routes.size };
}
module.exports = { runCases, assertUsage, parseSSE };
