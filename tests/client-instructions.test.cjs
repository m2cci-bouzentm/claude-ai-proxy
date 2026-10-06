const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { prepareToolRequest } = require('../dist/services/openai.service');
const { toolRequestSchema } = require('../dist/schemas/tool.schema');

const prepare = (messages) => prepareToolRequest(toolRequestSchema.parse({ model: 'claude-sonnet-4-6', messages }), 'claude-sonnet-4-6');
const opening = [
  { role: 'system', content: 'Be concise' },
  { role: 'developer', content: 'Use the caller workspace' },
  { role: 'user', content: 'Echo café' },
];

test('client system/developer messages lead the first user turn; request carries no client system', () => {
  const p = prepare(opening);
  assert.equal(p.request.system, undefined);
  assert.deepEqual(p.request.messages[0].content.slice(0, 2), [
    { type: 'text', text: '<client_instructions>\nBe concise\n\nUse the caller workspace\n</client_instructions>' },
    { type: 'text', text: 'Echo café' },
  ]);
});

test('client instruction block stays first and byte-identical as history grows (prefix cache)', () => {
  const first = prepare(opening);
  const later = prepare([...opening, { role: 'assistant', content: 'done' }, { role: 'user', content: 'next' }]);
  assert.deepEqual(later.request.messages[0], first.request.messages[0]);
  assert.equal(JSON.stringify(later.request.messages).split('<client_instructions>').length - 1, 1);
});

test('fixed Claude Code prompt carries no captured local session data', () => {
  const text = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'system_prompt.json'), 'utf8')).map((b) => b.text).join('\n');
  assert.match(text, /You are a Claude agent, built on Anthropic's Claude Agent SDK\./);
  assert.match(text, /# Context management/);
  for (const leaked of [/\/Users\//, /Primary working directory/, /^# auto memory/m, /^# Environment/m, /Platform: darwin/])
    assert.doesNotMatch(text, leaked);
});
