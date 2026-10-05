'use strict';
// Regression-only preload. No credentials, HTTP provider calls, or production injection switches.
const fs = require('node:fs');
const path = require('node:path');
const root = fs.existsSync(path.join(__dirname, 'dist')) ? __dirname : path.resolve(__dirname, '..');
require(path.join(root, 'dist/services/auth.service.js')).getAuth = async () => ({ accessToken: 'regression-provider-only' });
const seen = new Map();
global.fetch = async (url, options = {}) => {
  const path = new URL(url).pathname;
  const body = options.body ? JSON.parse(options.body) : {};
  const headers = new Headers(options.headers);
  fs.appendFileSync(process.env.REGRESSION_CAPTURE || '/tmp/provider-captures.jsonl', JSON.stringify({ path, body, session: headers.get('x-claude-code-session-id') }) + '\n');
  const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  if (options.method === 'HEAD') return new Response(null);
  if (path.endsWith('/count_tokens')) return json({ input_tokens: 42 });
  if (path.endsWith('/cache_touch')) return new Response(null, { status: 204 });
  if (path.endsWith('/usage')) return json({ five_hour: { utilization: 12.5 }, seven_day: { utilization: 4 } });
  if (path.endsWith('/profile')) return json({ account: { uuid: 'regression-account' } });
  if (/\/models\//.test(path)) return json({ id: path.split('/').at(-1), type: 'model', display_name: 'Regression model' });
  if (path.endsWith('/models')) return json({ data: [{ id: 'claude-sonnet-4-6', type: 'model' }], has_more: false });
  const key = JSON.stringify(body.messages);
  const prior = seen.get(key) || 0; seen.set(key, prior + 1);
  const long = key.length > 10000;
  const usage = { input_tokens: 80, output_tokens: 8, cache_read_input_tokens: long && prior ? 4096 : 0, cache_creation_input_tokens: long && !prior ? 4096 : 0 };
  const forced = body.tools?.length && body.tool_choice && body.tool_choice.type !== 'auto';
  const content = forced ? [{ type: 'tool_use', id: 'toolu_regression', name: 'echo', input: { text: 'HTTP_E2E_OK' } }] : [{ type: 'text', text: 'HTTP_E2E_OK' }];
  const message = { id: 'msg_regression', type: 'message', role: 'assistant', model: body.model, content, stop_reason: forced ? 'tool_use' : 'end_turn', stop_sequence: null, usage };
  if (!body.stream) return json(message);
  const block = content[0];
  const events = [
    { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { ...usage, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: forced ? { ...block, input: {} } : { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: forced ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } },
    { type: 'message_stop' },
  ];
  return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
};
