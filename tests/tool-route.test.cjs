const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { prepareToolRequest, collectToolResponse, createToolHandler } = require('../dist/tool-route');

const tool = { type: 'function', function: { name: 'echo', parameters: {
  type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false,
} } };
const request = (extra = {}) => ({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'Echo café' }], tools: [tool], ...extra });
function fixture({ calls = [{ id: 'toolu_one', name: 'echo', input: { text: 'café' } }], stop, truncated = false, error = false, empty = false, rawArgs } = {}) {
  const events = [{ type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0, cache_read_input_tokens: 4 } } }];
  if (!calls.length && !empty) {
    events.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done café' } }, { type: 'content_block_stop', index: 0 });
  }
  calls.forEach((c, i) => events.push({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', ...c, input: {} } },
    { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: rawArgs ?? JSON.stringify(c.input) } },
    { type: 'content_block_stop', index: i }));
  if (error) events.push({ type: 'error', error: { message: 'sensitive upstream text' } });
  events.push({ type: 'message_delta', delta: { stop_reason: stop ?? (calls.length ? 'tool_use' : 'end_turn') }, usage: { output_tokens: 5 } });
  if (!truncated) events.push({ type: 'message_stop' });
  const bytes = Buffer.from(events.map(e => `event: ${e.type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join(''));
  // Every byte separate: covers split UTF-8, JSON and CRLF frames.
  return new Response(new ReadableStream({ start(c) { for (const b of bytes) c.enqueue(Uint8Array.of(b)); c.close(); } }));
}

test('tool round trip preserves schemas, IDs, system instructions, and parallel results', async () => {
  const p = prepareToolRequest(request({ messages: [{ role: 'system', content: 'Be concise' }, { role: 'user', content: 'Echo café' }], tool_choice: 'required' }), 'fallback');
  assert.deepEqual(p.request.tools[0].input_schema, tool.function.parameters);
  assert.deepEqual(p.request.tool_choice, { type: 'any' });
  assert.equal(p.request.system, 'Be concise');
  const result = await collectToolResponse(fixture(), p);
  assert.equal(result.choices[0].finish_reason, 'tool_calls');
  assert.equal(result.usage.prompt_tokens, 7);
  const assistant = result.choices[0].message;
  const follow = prepareToolRequest(request({ messages: [...request().messages, assistant,
    { role: 'tool', tool_call_id: assistant.tool_calls[0].id, content: 'café' }] }), 'fallback');
  assert.deepEqual(follow.request.messages[1].content[0], { type: 'tool_use', id: 'toolu_one', name: 'echo', input: { text: 'café' } });
  assert.equal(follow.request.messages[2].content[0].tool_use_id, 'toolu_one');
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
  let aborted;
  const disconnected = new Promise(resolve => { aborted = resolve; });
  app.post('/tools/v1/chat/completions', createToolHandler(async (body, signal) => {
    if (body.model === 'disconnect') {
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted(); reject(new Error('aborted')); }, { once: true }));
    }
    return fixture();
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
    assert.equal(events[1].choices[0].delta.tool_calls[0].index, 0);
    assert.equal(events.at(-2).choices[0].finish_reason, 'tool_calls');
    assert.equal(events.at(-1).usage.total_tokens, 12);
    const controller = new AbortController();
    const pending = fetch(url, { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request({ model: 'disconnect' })) }).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 50)); controller.abort(); await pending;
    await Promise.race([disconnected, new Promise((_, reject) => setTimeout(() => reject(new Error('Disconnect did not abort upstream')), 1500))]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
