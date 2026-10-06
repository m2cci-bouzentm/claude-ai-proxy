const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")

test("auth module hot-reloading: picks up updated auth.json without process restart", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-auth-reload-"))
  try {
    process.env.PROXY_AUTH_DIR = tmpDir
    delete require.cache[require.resolve("../dist/lib/auth-storage.js")]
    delete require.cache[require.resolve("../dist/services/auth.service.js")]
    const storage = require("../dist/lib/auth-storage.js")
    const auth = require("../dist/services/auth.service.js")

    // First auth state: token 1
    const token1 = {
      type: "oauth",
      access: "sk-ant-reload-access-1",
      refresh: "sk-ant-reload-refresh-1",
      expires: Date.now() + 3600000,
      subscriptionType: "pro",
      rateLimitTier: "tier_default",
    }
    storage.write(token1)

    const res1 = await auth.getAuth()
    assert.equal(res1.accessToken, "sk-ant-reload-access-1")
    assert.equal(res1.subscriptionType, "pro")

    // Small delay to ensure mtime or file modification is detected
    await new Promise((r) => setTimeout(r, 50))

    // Update auth file on disk (simulate CLI import or external sync)
    const token2 = {
      type: "oauth",
      access: "sk-ant-reload-access-2",
      refresh: "sk-ant-reload-refresh-2",
      expires: Date.now() + 7200000,
      subscriptionType: "team",
      rateLimitTier: "tier_team",
    }
    storage.write(token2)

    // auth.getAuth should detect file change and return new tokens without restart
    const res2 = await auth.getAuth()
    assert.equal(res2.accessToken, "sk-ant-reload-access-2")
    assert.equal(res2.subscriptionType, "team")
    assert.equal(res2.rateLimitTier, "tier_team")
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.PROXY_AUTH_DIR
  }
})

test("auth module non-destructive: seed or read never deletes ~/.claude credentials", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-auth-nondestructive-"))
  try {
    process.env.PROXY_AUTH_DIR = tmpDir
    const fakeClaudeDir = path.join(tmpDir, "mock-claude")
    fs.mkdirSync(fakeClaudeDir, { recursive: true })
    const credPath = path.join(fakeClaudeDir, ".credentials.json")
    const sourceData = {
      claudeAiOauth: {
        accessToken: "sk-ant-source-preserve",
        refreshToken: "sk-ant-source-refresh",
        expiresAt: Date.now() + 3600000,
      },
    }
    fs.writeFileSync(credPath, JSON.stringify(sourceData, null, 2))

    process.env.CLAUDE_CONFIG_DIR = fakeClaudeDir
    delete require.cache[require.resolve("../dist/config/index.js")]
    delete require.cache[require.resolve("../dist/lib/auth-storage.js")]
    delete require.cache[require.resolve("../dist/lib/keychain.js")]
    delete require.cache[require.resolve("../dist/services/auth.service.js")]

    const auth = require("../dist/services/auth.service.js")
    const res = await auth.getAuth()
    assert.equal(res.accessToken, "sk-ant-source-preserve")

    // Confirm source credentials file was NOT deleted or mutated!
    assert.ok(fs.existsSync(credPath), "Source credentials file must still exist")
    const after = JSON.parse(fs.readFileSync(credPath, "utf-8"))
    assert.equal(after.claudeAiOauth.accessToken, "sk-ant-source-preserve")
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.PROXY_AUTH_DIR
    delete process.env.CLAUDE_CONFIG_DIR
  }
})
