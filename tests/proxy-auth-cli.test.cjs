const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")
const { spawnSync } = require("node:child_process")

test("proxy-auth help explains every interactive input with safe examples", () => {
  const cliPath = path.resolve(__dirname, "../bin/proxy-auth")
  const result = spawnSync(process.execPath, [cliPath, "--help"], { encoding: "utf8" })
  assert.equal(result.status, 0)
  assert.match(result.stderr, /browser login/i)
  assert.match(result.stderr, /access token.*example/i)
  assert.match(result.stderr, /refresh token.*example/i)
  assert.match(result.stderr, /expiry.*ISO/i)
  assert.match(result.stderr, /leave blank/i)
})

test("proxy-auth CLI: status subcommand output envelope and security", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-cli-test-"))
  try {
    const cliPath = path.resolve(__dirname, "../bin/proxy-auth")

    // Run status on unconfigured directory
    const env = { ...process.env, PROXY_AUTH_DIR: tmpDir }
    const resUnconf = spawnSync(process.execPath, [cliPath, "status"], { env, encoding: "utf-8" })
    assert.equal(resUnconf.status, 0)
    const statusUnconf = JSON.parse(resUnconf.stdout)
    assert.equal(statusUnconf.configured, false)

    // Import valid normalized OAuth via --file
    const authPayload = {
      type: "oauth",
      access: "sk-ant-test-access-123",
      refresh: "sk-ant-test-refresh-456",
      expires: Date.now() + 1800000,
      scopes: ["user:inference"],
      subscriptionType: "pro",
    }
    const importFile = path.join(tmpDir, "import.json")
    fs.writeFileSync(importFile, JSON.stringify(authPayload))

    const resImport = spawnSync(process.execPath, [cliPath, "import", "--file", importFile], { env, encoding: "utf-8" })
    assert.equal(resImport.status, 0)
    const importOutput = JSON.parse(resImport.stdout)
    assert.equal(importOutput.success, true)
    assert.equal(importOutput.configured, true)
    assert.equal(importOutput.subscriptionType, "pro")
    // Never leak token secrets
    assert.equal(importOutput.access, undefined)
    assert.equal(importOutput.refresh, undefined)
    assert.equal(resImport.stdout.includes("sk-ant-test-access-123"), false)
    assert.equal(resImport.stdout.includes("sk-ant-test-refresh-456"), false)

    // Run status again
    const resConf = spawnSync(process.execPath, [cliPath, "status"], { env, encoding: "utf-8" })
    assert.equal(resConf.status, 0)
    const statusConf = JSON.parse(resConf.stdout)
    assert.equal(statusConf.configured, true)
    assert.equal(statusConf.type, "oauth")
    assert.equal(statusConf.isExpired, false)
    assert.equal(statusConf.access, undefined)
    assert.equal(statusConf.refresh, undefined)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("proxy-auth CLI: import via stdin and rejection of invalid/secrets in argv", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-cli-stdin-"))
  try {
    const cliPath = path.resolve(__dirname, "../bin/proxy-auth")
    const env = { ...process.env, PROXY_AUTH_DIR: tmpDir }

    const nativeTokens = {
      claudeAiOauth: {
        accessToken: "sk-ant-native-stdin-access",
        refreshToken: "sk-ant-native-stdin-refresh",
        expiresAt: Date.now() + 3600000,
        scopes: ["user:profile", "user:inference"],
      },
    }

    // Stdin import
    const resStdin = spawnSync(process.execPath, [cliPath, "import", "-"], {
      env,
      input: JSON.stringify(nativeTokens),
      encoding: "utf-8",
    })
    assert.equal(resStdin.status, 0)
    const out = JSON.parse(resStdin.stdout)
    assert.equal(out.success, true)
    assert.equal(out.configured, true)
    assert.equal(resStdin.stdout.includes("sk-ant-native-stdin-refresh"), false)

    // Rejection of invalid payload
    const resBad = spawnSync(process.execPath, [cliPath, "import", "-"], {
      env,
      input: "not-json",
      encoding: "utf-8",
    })
    assert.notEqual(resBad.status, 0)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("proxy-auth CLI: login with mocked claude CLI binary handles options and normalizes output", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-cli-login-"))
  try {
    const cliPath = path.resolve(__dirname, "../bin/proxy-auth")
    const fakeBinDir = path.join(tmpDir, "bin")
    fs.mkdirSync(fakeBinDir, { recursive: true })

    // Create a fake `claude` executable
    const fakeClaude = path.join(fakeBinDir, "claude")
    const fakeScript = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);

// Check if called as 'auth login'
if (args[0] === 'auth' && args[1] === 'login') {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, '.claude');
  fs.mkdirSync(configDir, { recursive: true });
  const payload = {
    claudeAiOauth: {
      accessToken: 'sk-ant-login-mock-access',
      refreshToken: 'sk-ant-login-mock-refresh',
      expiresAt: Date.now() + 7200000,
      scopes: ['user:inference']
    }
  };
  fs.writeFileSync(path.join(configDir, '.credentials.json'), JSON.stringify(payload));
  fs.writeFileSync(path.join(configDir, 'invoked_args.json'), JSON.stringify(args));
  console.log('Login successful in fake claude');
  process.exit(0);
}
process.exit(1);
`
    fs.writeFileSync(fakeClaude, fakeScript, { mode: 0o755 })

    const authDir = path.join(tmpDir, "data")
    const env = {
      ...process.env,
      PROXY_AUTH_DIR: authDir,
      PATH: `${fakeBinDir}:${process.env.PATH}`,
    }

    // 1. Login with --browser (default in contract) and provider flags (--sso, --console, --email)
    const resLogin = spawnSync(
      process.execPath,
      [cliPath, "login", "--browser", "--sso", "--email", "user@example.com"],
      { env, encoding: "utf-8" },
    )
    assert.equal(resLogin.status, 0)
    const loginOut = JSON.parse(resLogin.stdout)
    assert.equal(loginOut.success, true)
    assert.equal(loginOut.configured, true)
    assert.equal(resLogin.stdout.includes("sk-ant-login-mock-refresh"), false)

    // Verify isolated CLAUDE_CONFIG_DIR was used underneath authDir
    const expectedConfigDir = path.join(authDir, ".claude")
    assert.ok(fs.existsSync(path.join(expectedConfigDir, "invoked_args.json")))
    const invokedArgs = JSON.parse(fs.readFileSync(path.join(expectedConfigDir, "invoked_args.json"), "utf-8"))
    assert.deepEqual(invokedArgs.slice(0, 2), ["auth", "login"])
    assert.ok(invokedArgs.includes("--sso"))
    assert.ok(invokedArgs.includes("--email"))
    assert.ok(invokedArgs.includes("user@example.com"))

    // Check canonical auth.json exists in authDir
    assert.ok(fs.existsSync(path.join(authDir, "auth.json")))
    const canonical = JSON.parse(fs.readFileSync(path.join(authDir, "auth.json"), "utf-8"))
    assert.equal(canonical.type, "oauth")
    assert.equal(canonical.access, "sk-ant-login-mock-access")
    assert.equal(canonical.refresh, "sk-ant-login-mock-refresh")
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("proxy-auth token wizard values save pasted fields one by one", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-token-wizard-"))
  const previous = process.env.PROXY_AUTH_DIR
  try {
    process.env.PROXY_AUTH_DIR = tmpDir
    const { runTokenWizardImport } = require("../dist/cli")
    const status = runTokenWizardImport({
      access: "wizard-access",
      refresh: "wizard-refresh",
      expires: new Date(Date.now() + 3600000).toISOString(),
    })
    assert.equal(status.configured, true)
    assert.equal(status.accessPresent, true)
    assert.equal(status.refreshPresent, true)
    const stored = JSON.parse(fs.readFileSync(path.join(tmpDir, "auth.json"), "utf8"))
    assert.equal(stored.access, "wizard-access")
    assert.equal(stored.refresh, "wizard-refresh")
    assert.equal(runTokenWizardImport({ access: "", refresh: "refresh-only", expires: "" }).isExpired, true)
    assert.throws(() => runTokenWizardImport({ access: "access-only", refresh: "", expires: "" }), /expiry/i)
  } finally {
    if (previous === undefined) delete process.env.PROXY_AUTH_DIR
    else process.env.PROXY_AUTH_DIR = previous
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})
