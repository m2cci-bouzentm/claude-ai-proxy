const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('architecture contract: canonical module structure exists and legacy unmounted routes are removed', () => {
  // 1. Required canonical modules exist
  const requiredModules = [
    'src/config/index.ts',
    'src/config/models.ts',
    'src/controllers/openai.controller.ts',
    'src/services/openai.service.ts',
    'src/routes/openai.ts',
    'src/services/anthropic.service.ts',
    'src/routes/anthropic.ts',
    'src/services/auth.service.ts',
    'src/lib/auth-storage.ts',
    'src/middleware/auth.ts',
    'src/middleware/validate.ts',
    'src/utils/abort.ts',
    'src/jobs/index.ts',
    'src/jobs/refresh-auth.ts',
    'src/types/auth.ts',
    'src/types/openai.ts',
    'src/types/anthropic.ts',
    'src/schemas/config.schema.ts',
    'src/schemas/auth.schema.ts',
    'src/schemas/openai.schema.ts',
    'src/schemas/anthropic.schema.ts',
    'src/schemas/provider.schema.ts',
  ];

  for (const mod of requiredModules) {
    assert.ok(fs.existsSync(path.join(root, mod)), `Required module missing: ${mod}`);
  }

  // 2. Unused legacy routes and controllers must NOT exist
  const forbiddenFiles = [
    'src/routes/chat.ts',
    'src/controllers/chat.controller.ts',
  ];

  for (const forbidden of forbiddenFiles) {
    assert.ok(!fs.existsSync(path.join(root, forbidden)), `Unused legacy file should be deleted: ${forbidden}`);
  }

  // 3. Router composition and mounted endpoints
  const indexSource = fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8');
  assert.match(indexSource, /openaiRouter/);
  assert.match(indexSource, /anthropicRouter/);
  assert.doesNotMatch(indexSource, /chatRouter/);
  assert.doesNotMatch(indexSource, /toolRouter/);

  // 4. Verify no old routes or legacy paths
  assert.doesNotMatch(indexSource, /app\.use\(['"]\/v1['"]/);
  assert.doesNotMatch(indexSource, /app\.use\(['"]\/tools\/v1['"]/);
});
