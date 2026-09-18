const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { prepareToolRequest, collectToolResponse, createToolHandler } = require('../dist/tool-route');

const tool = { type: 'function', function: { name: 'echo', parameters: {
  type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false,
} } };
const request = (extra = {}) => ({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'Echo café' }], tools: [tool], ...extra });
function fixture({ calls = [{ id: 'toolu_one', name: 'echo', input: { text: 'café' } }], stop, truncated = false, error = false, empty = false, rawArgs, thinking, usage = {} } = {}) {
  const events = [{ type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0, cache_read_input_tokens: 4, ...usage } } }];
  const offset = thinking ? 1 : 0;
  if (thinking) events.push({ type: 'content_block_start', index: 0, content_block: thinking }, { type: 'content_block_stop', index: 0 });
  if (!calls.length && !empty) {
    events.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done café' } }, { type: 'content_block_stop', index: 0 });
  }
  calls.forEach((c, i) => events.push({ type: 'content_block_start', index: i + offset, content_block: { type: 'tool_use', ...c, input: {} } },
    { type: 'content_block_delta', index: i + offset, delta: { type: 'input_json_delta', partial_json: rawArgs ?? JSON.stringify(c.input) } },
    { type: 'content_block_stop', index: i + offset }));
  if (error) events.push({ type: 'error', error: { message: 'sensitive upstream text' } });
  events.push({ type: 'message_delta', delta: { stop_reason: stop ?? (calls.length ? 'tool_use' : 'end_turn') }, usage: { output_tokens: 5 } });
  if (!truncated) events.push({ type: 'message_stop' });
  const bytes = Buffer.from(events.map(e => `event: ${e.type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join(''));
  // Every byte separate: covers split UTF-8, JSON and CRLF frames.
  return new Response(new ReadableStream({ start(c) { for (const b of bytes) c.enqueue(Uint8Array.of(b)); c.close(); } }));
}

test('tool round trip preserves schemas, IDs, consumer instructions at user level, and parallel results', async () => {
  const p = prepareToolRequest(request({ messages: [{ role: 'system', content: 'Be concise' }, { role: 'developer', content: 'Use the caller workspace' }, { role: 'user', content: 'Echo café' }], tool_choice: 'required' }), 'fallback');
  assert.deepEqual(p.request.tools[0].input_schema, tool.function.parameters);
  assert.deepEqual(p.request.tool_choice, { type: 'any' });
  assert.equal(p.request.system, undefined);
  assert.equal(p.request.messages[0].role, 'user');
  const prefix = p.request.messages[0].content[0].text;
  assert.deepEqual(JSON.parse(prefix.slice(prefix.indexOf('\n') + 1)), [
    { source_role: 'system', content: 'Be concise' }, { source_role: 'developer', content: 'Use the caller workspace' },
  ]);
  assert.equal(p.request.messages[0].content[1].text, 'Echo café');
  const result = await collectToolResponse(fixture(), p);
  assert.equal(result.choices[0].finish_reason, 'tool_calls');
  assert.equal(result.usage.prompt_tokens, 7);
  const assistant = result.choices[0].message;
  const follow = prepareToolRequest(request({ messages: [...request().messages, assistant,
    { role: 'tool', tool_call_id: assistant.tool_calls[0].id, content: 'café' }] }), 'fallback');
  assert.deepEqual(follow.request.messages[1].content[0], { type: 'tool_use', id: 'toolu_one', name: 'echo', input: { text: 'café' } });
  assert.deepEqual(follow.request.messages[2].content[0], { type: 'tool_result', tool_use_id: 'toolu_one', content: 'café' });
  const final = await collectToolResponse(fixture({ calls: [] }), follow);
  assert.equal(final.choices[0].message.content, 'done café');
  const two = await collectToolResponse(fixture({ calls: [
    { id: 'a', name: 'echo', input: { text: 'one' } }, { id: 'b', name: 'echo', input: { text: 'two' } },
  ] }), p);
  const multi = prepareToolRequest(request({ messages: [...request().messages, two.choices[0].message,
    { role: 'tool', tool_call_id: 'b', content: 'two' }, { role: 'tool', tool_call_id: 'a', content: 'one' }] }), 'fallback');
  assert.equal(multi.request.messages[2].content.length, 2);
});

test('constraints reject malformed, unknown, truncated or forbidden calls', async () => {
  for (const extra of [{ tool_choice: 'bad' }, { tool_choice: { type: 'function', function: { name: 'unknown' } } }, { parallel_tool_calls: 'false' }, { n: 2 },
    { tools: [{ ...tool, function: { ...tool.function, parameters: { type: 'object', properties: { x: { $ref: 'https://example.com/schema' } } } } }] }]) {
    assert.throws(() => prepareToolRequest(request(extra), 'fallback'));
  }
  const p = prepareToolRequest(request(), 'fallback');
  const disabled = prepareToolRequest(request({ tool_choice: 'none' }), 'fallback');
  assert.equal(disabled.request.tools, undefined);
  assert.equal(disabled.request.tool_choice, undefined);
  for (const model of ['claude-fable-5-1', 'future-model']) {
    assert.deepEqual(prepareToolRequest(request({ model, tool_choice: 'required' }), 'fallback').request.tool_choice, { type: 'any' });
    assert.deepEqual(prepareToolRequest(request({ model, tool_choice: { type: 'function', function: { name: 'echo' } } }), 'fallback').request.tool_choice, { type: 'tool', name: 'echo' });
  }
  const thinking = { type: 'thinking', thinking: 'Signed reasoning', signature: 'opaque-signature' };
  const preserved = prepareToolRequest(request({ messages: [...request().messages, { role: 'assistant', content: 'done', reasoning_details: [thinking] }, { role: 'user', content: 'continue' }] }), 'fallback');
  assert.deepEqual(preserved.request.messages[1].content[0], thinking);
  for (const options of [{ truncated: true }, { error: true }, { stop: 'max_tokens' }, { calls: [], empty: true }, { rawArgs: '{"text":"unfinished' },
    { calls: [{ id: 'a', name: 'invented', input: {} }] }, { calls: [{ id: 'a', name: 'echo', input: { text: 5 } }] }]) {
    await assert.rejects(collectToolResponse(fixture(options), p));
  }
  await assert.rejects(collectToolResponse(fixture(), prepareToolRequest(request({ tool_choice: 'none' }), 'fallback')));
  await assert.rejects(collectToolResponse(fixture({ calls: [] }), prepareToolRequest(request({ tool_choice: 'required' }), 'fallback')));
  const forced = prepareToolRequest(request({ tool_choice: { type: 'function', function: { name: 'echo' } }, parallel_tool_calls: false }), 'fallback');
  assert.deepEqual(forced.request.tool_choice, { type: 'tool', name: 'echo', disable_parallel_tool_use: true });
  await assert.rejects(collectToolResponse(fixture({ calls: [{ id: 'a', name: 'echo', input: { text: 'a' } }, { id: 'b', name: 'echo', input: { text: 'b' } }] }), forced));
  assert.throws(() => prepareToolRequest(request({ messages: [{ role: 'user', content: 'hello' }, { role: 'tool', tool_call_id: 'absent', content: 'x' }] }), 'fallback'));
});

test('HTTP SSE uses stable IDs, usage, finish and DONE; disconnect aborts upstream', async () => {
  const app = express(); app.use(express.json());
  const thinking = { type: 'thinking', thinking: 'Signed reasoning', signature: 'opaque-signature' };
  let aborted;
  const disconnected = new Promise(resolve => { aborted = resolve; });
  app.post('/tools/v1/chat/completions', createToolHandler(async (body, signal) => {
    if (body.model === 'disconnect') {
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted(); reject(new Error('aborted')); }, { once: true }));
    }
    return fixture({ thinking, usage: { cache_creation_input_tokens: 6 } });
  }, 'fallback'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/tools/v1/chat/completions`;
  try {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request({ stream: true, stream_options: { include_usage: true } })) });
    assert.equal(response.status, 200);
    const raw = await response.text(); assert.ok(raw.endsWith('data: [DONE]\n\n'));
    const events = raw.split('\n\n').filter(s => s.startsWith('data: {')).map(s => JSON.parse(s.slice(6)));
    assert.equal(new Set(events.map(e => e.id)).size, 1);
    assert.deepEqual(events[1].choices[0].delta.reasoning_details, [thinking]);
    assert.equal(events[2].choices[0].delta.tool_calls[0].index, 0);
    assert.equal(events.at(-2).choices[0].finish_reason, 'tool_calls');
    assert.deepEqual(events.at(-1).usage, { prompt_tokens: 13, completion_tokens: 5, total_tokens: 18,
      prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 6 } });
    const controller = new AbortController();
    const pending = fetch(url, { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request({ model: 'disconnect' })) }).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 50)); controller.abort(); await pending;
    await Promise.race([disconnected, new Promise((_, reject) => setTimeout(() => reject(new Error('Disconnect did not abort upstream')), 1500))]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('server cache policy leaves message roles/content intact and ignores client markers', () => {
  const previous = process.env.TOOL_PROMPT_CACHE_TTL;
  try {
    delete process.env.TOOL_PROMPT_CACHE_TTL;
    const input = request({ cache_control: { type: 'ephemeral', ttl: 'invalid' },
      messages: [{ role: 'system', content: 'SYSTEM_USER_CONTEXT' },
        { role: 'developer', content: 'DEVELOPER_USER_CONTEXT' },
        { role: 'user', content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral', ttl: '1h' } }] }] });
    const original = structuredClone(input);
    const enabled = prepareToolRequest(input, '').request;
    assert.deepEqual(enabled.cache_control, { type: 'ephemeral', ttl: '5m' });
    assert.equal(enabled.system, undefined);
    assert.equal(enabled.messages[0].role, 'user');
    assert.match(enabled.messages[0].content[0].text, /SYSTEM_USER_CONTEXT/);
    assert.match(enabled.messages[0].content[0].text, /DEVELOPER_USER_CONTEXT/);
    assert.deepEqual(enabled.messages[0].content[1], { type: 'text', text: 'hello' });
    assert.deepEqual(input, original);
    process.env.TOOL_PROMPT_CACHE_TTL = 'off';
    const disabled = prepareToolRequest(input, '').request;
    assert.equal(disabled.cache_control, undefined);
    const { cache_control, ...withoutCache } = enabled;
    assert.deepEqual(disabled, withoutCache);
    process.env.TOOL_PROMPT_CACHE_TTL = '1h';
    assert.deepEqual(prepareToolRequest(input, '').request.cache_control, { type: 'ephemeral', ttl: '1h' });
    process.env.TOOL_PROMPT_CACHE_TTL = 'bad';
    assert.throws(() => prepareToolRequest(input, ''), e => e.status === 500);
  } finally {
    if (previous === undefined) delete process.env.TOOL_PROMPT_CACHE_TTL;
    else process.env.TOOL_PROMPT_CACHE_TTL = previous;
  }
});

test('JSON usage separates cache reads/writes without double-counting total input', async () => {
  const p = prepareToolRequest(request(), '');
  for (const [read, write] of [[4, 6], [0, 0], [null, null]]) {
    const result = await collectToolResponse(fixture({ usage: { cache_read_input_tokens: read, cache_creation_input_tokens: write } }), p);
    const prompt = 3 + (read ?? 0) + (write ?? 0);
    assert.deepEqual(result.usage, { prompt_tokens: prompt, completion_tokens: 5, total_tokens: prompt + 5,
      prompt_tokens_details: { cached_tokens: read ?? 0, cache_write_tokens: write ?? 0 } });
  }
});

test('images preserve ordering, user-level instructions and tool-result history', () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';
  const img = { type: 'image_url', image_url: { url: 'data:image/png;base64,' + png, detail: 'high' } };
  const parts = [{ type: 'text', text: 'before' }, img, { type: 'text', text: 'after' },
    { type: 'image_url', image_url: { url: 'https://example.com/picture.png' } }];
  const p = prepareToolRequest(request({ messages: [{ role: 'system', content: 'consumer' }, { role: 'user', content: parts }] }), 'fallback').request;
  assert.equal(p.system, undefined);
  assert.equal(p.messages[0].role, 'user');
  assert.deepEqual(p.messages[0].content.slice(1), [parts[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }, parts[2], { type: 'image', source: { type: 'url', url: 'https://example.com/picture.png' } }]);
  const follow = prepareToolRequest(request({ messages: [{ role: 'user', content: 'look' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'image_call', type: 'function', function: { name: 'echo', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'image_call', content: [img] }] }), 'fallback').request;
  assert.deepEqual(follow.messages[2].content[0], { type: 'tool_result', tool_use_id: 'image_call', content: [p.messages[0].content[2]] });
  for (const url of ['file:///etc/passwd', 'https://user:pass@example.com/a', 'data:image/svg+xml;base64,AAAA', 'data:image/png;base64,%%%', 'data:image/png;base64,AB==', 'data:image/png;base64,' + Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64')]) {
    assert.throws(() => prepareToolRequest(request({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }] }), 'fallback'));
  }
  for (const role of ['system', 'developer', 'assistant']) {
    assert.throws(() => prepareToolRequest(request({ messages: [{ role, content: [img] }, { role: 'user', content: 'hi' }] }), 'fallback'));
  }
});


test('request boundary rejects invalid shapes without coercion or forwarding', async () => {
  let forwarded = 0;
  const app = express(); app.use(express.json());
  app.post('/', createToolHandler(async () => { forwarded++; return fixture(); }, 'fallback'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    for (const extra of [
      { messages: [] }, { messages: [{ role: 'invalid', content: 'hi' }] },
      { messages: [{ role: 'user', content: 42 }] }, { stream: 'true' },
      { max_tokens: '100' }, { temperature: 2 }, { stream_options: { include_usage: 1 } },
      { tools: [{ type: 'function', function: { name: 42 } }] },
      { response_format: { type: 'json_object' } },
      { messages: [...request().messages, { role: 'assistant', content: null,
        tool_calls: [{ id: 'a', type: 'function', function: { name: 'echo', arguments: '[]' } }] }] },
      { messages: [...request().messages, { role: 'assistant', content: 'hi',
        reasoning_details: [{ type: 'thinking', thinking: 'text', signature: 1 }] }] },
    ]) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request(extra)),
      });
      assert.equal(response.status, 400, JSON.stringify(extra));
      assert.equal((await response.json()).error.type, 'invalid_request_error');
    }
    assert.equal(forwarded, 0);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('schema normalization preserves text, options and local parameter references', async () => {
  const parameters = { type: 'object', definitions: { text: { type: 'string' } },
    properties: { text: { $ref: '#/definitions/text' } }, required: ['text'] };
  const p = prepareToolRequest(request({
    tools: [{ type: 'function', function: { name: 'echo', parameters } }],
    messages: [{ role: 'system', content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] },
      ...request().messages], stop: 'END', temperature: 0, top_p: 1, max_completion_tokens: 100,
  }), 'fallback');
  assert.deepEqual(p.request.tools[0].input_schema, parameters);
  assert.match(p.request.messages[0].content[0].text, /first\\nsecond/);
  assert.deepEqual(p.request.stop_sequences, ['END']);
  assert.equal(p.request.max_tokens, 100);
  assert.equal(p.request.temperature, 0);
  assert.equal(p.request.top_p, 1);
  await collectToolResponse(fixture(), p);
  await assert.rejects(collectToolResponse(fixture({ calls: [{ id: 'a', name: 'echo', input: { text: 1 } }] }), p));
});
