const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-hardening-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, PROXY_AUTH_DIR: path.join(dir, 'data') };
  const run = (args, input) => spawnSync(process.execPath, [path.join(root, 'bin/proxy-auth'), ...args], { env, input, encoding: 'utf8', timeout: 5000 });
  return { dir, env, run };
}
test('login preserves native input and prompts, restricts child environment', t => {
  const { dir, env, run } = fixture(t);
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const fs = require('node:fs');
console.log('browser-url-prompt'); console.error('native-stderr');
const input = fs.readFileSync(0, 'utf8');
fs.writeFileSync(process.env.CLAUDE_CONFIG_DIR + '/observed.json', JSON.stringify({input, args:process.argv.slice(2), env:process.env}));
fs.writeFileSync(process.env.CLAUDE_CONFIG_DIR + '/.credentials.json', JSON.stringify({type:'oauth',access:'test-access',refresh:'test-refresh',expires:4102444800000}));
`, { mode: 0o755 });
  Object.assign(env, { PATH: bin + ':' + process.env.PATH, API_KEY: 'secret', OPENAI_API_KEY: 'secret', ANTHROPIC_AUTH_TOKEN: 'secret', ANTHROPIC_BASE_URL: 'http://bad', CLAUDE_CODE_USE_BEDROCK: '1', AWS_SECRET_ACCESS_KEY: 'secret', NODE_OPTIONS: '--trace-warnings', CUSTOM_SECRET: 'secret' });
  const result = run(['login', '--sso', '--console', '--email', 'me@example.com'], 'native-code\n');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).success, true);
  assert.match(result.stderr, /browser-url-prompt/); assert.match(result.stderr, /native-stderr/);
  const observed = JSON.parse(fs.readFileSync(path.join(env.PROXY_AUTH_DIR, '.claude/observed.json')));
  assert.equal(observed.input, 'native-code\n');
  assert.deepEqual(observed.args, ['auth', 'login', '--sso', '--console', '--email', 'me@example.com']);
  for (const key of ['API_KEY','OPENAI_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','CLAUDE_CODE_USE_BEDROCK','AWS_SECRET_ACCESS_KEY','NODE_OPTIONS','CUSTOM_SECRET','PROXY_AUTH_DIR']) assert.equal(observed.env[key], undefined, key);
  assert.equal(observed.env.HOME, env.PROXY_AUTH_DIR);
});
test('imports reject oversize stdin/files and hide JSON parser excerpts', t => {
  const { dir, run } = fixture(t);
  for (const payload of ['x'.repeat(65537), '{"access":"private-marker",INVALID}']) {
    for (const file of [false, true]) {
      const source = path.join(dir, 'input.json'); fs.writeFileSync(source, payload);
      const result = run(file ? ['import','--file',source] : ['import','-'], file ? undefined : payload);
      assert.notEqual(result.status, 0); assert.equal(result.stdout, '');
      assert.ok(!result.stderr.includes('private-marker'));
      if (payload.length > 65536) assert.match(result.stderr, /64 KiB/);
    }
  }
});
test('imports accept exact 64 KiB and reject FIFO without blocking', t => {
  const { dir, run } = fixture(t);
  const json = JSON.stringify({type:'oauth',access:'bounded-access',refresh:'bounded-refresh',expires:4102444800000});
  const payload = json + ' '.repeat(65536 - Buffer.byteLength(json));
  const source = path.join(dir, 'boundary.json'); fs.writeFileSync(source, payload);
  for (const args of [['import','-'], ['import','--file',source]]) {
    const result = run(args, payload); assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).configured, true);
  }
  const fifo = path.join(dir, 'fifo');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  const result = run(['import','--file',fifo]);
  assert.equal(result.error, undefined); assert.notEqual(result.status, 0);
  assert.match(result.stderr, /regular file/);
});
test('compose separates host volume from container auth directory', () => {
  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
  assert.match(compose, /\$\{PROXY_AUTH_VOLUME:-claude-proxy-data\}:\/data/);
  assert.match(compose, /PROXY_AUTH_DIR=\/data/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, '.env.example'), 'utf8'), /^PROXY_AUTH_DIR=\/data$/m);
});
