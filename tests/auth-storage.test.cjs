const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")

test("storage contract: paths, permissions, atomic write, safe file, and status", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-auth-test-"))
  try {
    process.env.PROXY_AUTH_DIR = tmpDir
    delete require.cache[require.resolve("../dist/lib/auth-storage.js")]
    const storage = require("../dist/lib/auth-storage.js")

    assert.equal(storage.getAuthDir(), tmpDir)
    assert.equal(storage.getAuthFile(), path.join(tmpDir, "auth.json"))

    const customDir = path.join(tmpDir, "nested-auth")
    process.env.PROXY_AUTH_DIR = customDir
    delete require.cache[require.resolve("../dist/lib/auth-storage.js")]
    const storage2 = require("../dist/lib/auth-storage.js")
    storage2.ensureAuthDir()
    const dirStat = fs.statSync(customDir)
    assert.equal(dirStat.mode & 0o777, 0o700)

    let status = storage2.getStatus()
    assert.equal(status.configured, false)

    const sampleOAuth = {
      type: "oauth",
      access: "sk-ant-access-123",
      refresh: "sk-ant-refresh-456",
      expires: Date.now() + 3600000,
      scopes: ["user:inference", "user:profile"],
      subscriptionType: "pro",
      rateLimitTier: "tier_default",
    }
    storage2.write(sampleOAuth)

    const fileStat = fs.statSync(storage2.getAuthFile())
    assert.equal(fileStat.mode & 0o777, 0o600)

    status = storage2.getStatus()
    assert.equal(status.configured, true)
    assert.equal(status.type, "oauth")
    assert.equal(status.isExpired, false)
    assert.equal(typeof status.expiresAt, "string")
    assert.equal(status.subscriptionType, "pro")
    assert.equal(status.rateLimitTier, "tier_default")

    // Never leak token values in status
    assert.equal(status.access, undefined)
    assert.equal(status.refresh, undefined)
    assert.equal(status.accessToken, undefined)
    assert.equal(status.refreshToken, undefined)

    // Test rejection of symlinks
    const linkTarget = path.join(tmpDir, "target.json")
    fs.writeFileSync(linkTarget, "{}")
    const linkFile = path.join(customDir, "symlink-auth.json")
    fs.symlinkSync(linkTarget, linkFile)
    assert.throws(() => storage2.assertSafeFile(linkFile), /symlink/i)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.PROXY_AUTH_DIR
  }
})

test("storage normalizeAndSave: handles native Claude Linux credentials and normalized OAuth", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-auth-norm-"))
  try {
    process.env.PROXY_AUTH_DIR = tmpDir
    delete require.cache[require.resolve("../dist/lib/auth-storage.js")]
    const storage = require("../dist/lib/auth-storage.js")

    const exp = Date.now() + 7200000
    // 1. Native Claude .credentials.json claudeAiOauth format
    const nativeInput = {
      claudeAiOauth: {
        accessToken: "sk-ant-native-access",
        refreshToken: "sk-ant-native-refresh",
        expiresAt: exp,
        scopes: ["user:inference"],
        subscriptionType: "team",
        rateLimitTier: "tier_team",
      },
    }
    const saved1 = storage.normalizeAndSave(nativeInput)
    assert.equal(saved1.type, "oauth")
    assert.equal(saved1.access, "sk-ant-native-access")
    assert.equal(saved1.refresh, "sk-ant-native-refresh")
    assert.equal(saved1.expires, exp)
    assert.deepEqual(saved1.scopes, ["user:inference"])
    assert.equal(saved1.subscriptionType, "team")
    assert.equal(saved1.rateLimitTier, "tier_team")

    // 2. Normalized OAuth input
    const normalizedInput = {
      type: "oauth",
      access: "sk-ant-norm-access",
      refresh: "sk-ant-norm-refresh",
      expires: exp + 1000,
      scopes: ["user:profile"],
      subscriptionType: "pro",
      rateLimitTier: "tier_default",
    }
    const saved2 = storage.normalizeAndSave(normalizedInput)
    assert.equal(saved2.access, "sk-ant-norm-access")
    assert.equal(saved2.refresh, "sk-ant-norm-refresh")
    assert.equal(saved2.expires, exp + 1000)

    // 3. Invalid inputs: empty tokens, malformed JSON, missing refresh
    assert.throws(() => storage.normalizeAndSave({}), /invalid/i)
    assert.throws(() => storage.normalizeAndSave({ claudeAiOauth: { accessToken: "" } }), /invalid/i)
    assert.throws(() => storage.normalizeAndSave({ type: "oauth", access: "foo" }), /invalid/i)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.PROXY_AUTH_DIR
  }
})
