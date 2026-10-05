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
  async function request(path, body, method = body ? 'POST' : 'GET', expectedStatus = 200) {
    routes.add(`${method} ${path}`);
    const response = await fetch(baseURL.replace(/\/$/, '') + path, { method, headers: { authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey, 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-claude-code-session-id': session }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120000) });
    assert.equal(response.status, expectedStatus, `${method} ${path}: ${response.status} ${await (response.status !== expectedStatus ? response.text() : Promise.resolve(''))}`);
    return response;
  }
  assert.equal((await request('/health')).status, 200);
  const models = await (await request('/openai/v1/models')).json();
  assert.equal(models.object, 'list');
  assert.equal(models.data.length, 16, 'OpenAI catalog must advertise 16 models');
  for (const m of models.data) {
    assert.equal(typeof m.id, 'string');
    assert.equal(typeof m.context_length, 'number');
    assert.equal(m.object, 'model');
    assert.equal(typeof m.created, 'number');
    assert.equal(m.owned_by, 'anthropic');
  }
  assert.ok(models.data.some(m => m.id === 'claude-sonnet-4-6'));
  assert.ok(models.data.some(m => m.id === 'claude-haiku-4-5-20251001'));

  const nativeModels = await (await request('/anthropic/v1/models')).json();
  assert.equal(nativeModels.data.length, 13, 'Anthropic catalog must advertise 13 models');
  for (const m of nativeModels.data) {
    assert.equal(m.type, 'model');
    assert.equal(typeof m.id, 'string');
    assert.equal(typeof m.display_name, 'string');
    assert.equal(typeof m.created_at, 'string');
  }
  assert.ok(nativeModels.data.some(m => m.id === 'claude-sonnet-4-6'));
  assert.ok(nativeModels.data.some(m => m.id === 'claude-haiku-4-5-20251001'));
  assert.equal((await (await request(`/anthropic/v1/models/${model}`)).json()).id, model);

  // Model switching: verify two advertised selections reach upstream with exact IDs on both protocols
  for (const targetModel of ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001']) {
    const oRes = await (await request('/openai/v1/chat/completions', { model: targetModel, max_tokens: 32, messages: [{ role: 'user', content: 'model test' }] })).json();
    assert.equal(oRes.model, targetModel, `OpenAI model selection ${targetModel}`);
    const aRes = await (await request('/anthropic/v1/messages', { model: targetModel, max_tokens: 32, messages: [{ role: 'user', content: 'model test' }] })).json();
    assert.equal(aRes.model, targetModel, `Anthropic model selection ${targetModel}`);
  }

  // OpenCode Draft 2020-12 payload with read/edit/write tools and system/developer authority
  const opencodeTools = [
    {
      type: 'function',
      function: {
        name: 'read',
        description: 'Read a file from disk',
        parameters: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          properties: { filePath: { type: 'string' } },
          required: ['filePath'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'edit',
        description: 'Edit a file on disk',
        parameters: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          $defs: { contentDef: { type: 'string' } },
          properties: {
            filePath: { type: 'string' },
            oldString: { $ref: '#/$defs/contentDef' },
            newString: { type: 'string' },
          },
          required: ['filePath', 'oldString', 'newString'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write',
        description: 'Write a file to disk',
        parameters: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          properties: {
            filePath: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['filePath', 'content'],
          additionalProperties: false,
        },
      },
    },
  ];
  const opencodeMessages = [
    { role: 'system', content: 'OpenCode system authority prompt.' },
    { role: 'developer', content: 'OpenCode developer guidance instructions.' },
    { role: 'user', content: 'Use read tool on /workspace/src/index.ts.' },
  ];
  const ocCallRes = await (await request('/openai/v1/chat/completions', {
    model,
    messages: opencodeMessages,
    tools: opencodeTools,
    tool_choice: { type: 'function', function: { name: 'read' } },
  })).json();
  assert.equal(ocCallRes.choices[0].finish_reason, 'tool_calls');
  const ocCall = ocCallRes.choices[0].message.tool_calls[0];
  assert.equal(ocCall.function.name, 'read');
  assert.equal(ocCall.id, 'toolu_regression_read');
  const ocArgs = JSON.parse(ocCall.function.arguments);
  assert.equal(typeof ocArgs.filePath, 'string');
  assert.equal(ocArgs.filePath, '/workspace/src/index.ts');

  // OpenCode tool-result continuation roundtrip
  const ocContinuationMessages = [
    ...opencodeMessages,
    ocCallRes.choices[0].message,
    { role: 'tool', tool_call_id: ocCall.id, content: 'export const status = "OPENCODE_CONTINUATION_OK";' },
  ];
  const ocContinuationRes = await (await request('/openai/v1/chat/completions', {
    model,
    messages: ocContinuationMessages,
    tools: opencodeTools,
  })).json();
  assert.equal(ocContinuationRes.choices[0].finish_reason, 'stop');
  assert.equal(ocContinuationRes.choices[0].message.content, 'HTTP_E2E_OK');
  assertUsage(ocContinuationRes, 'openai');

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
  await request('/anthropic/v1/messages/cache_touch', { model, messages: basic }, 'POST', 404);
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
