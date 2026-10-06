const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const crypto = require("node:crypto")
const storage = require("../dist/lib/auth-storage")
const token = () => crypto.randomBytes(24).toString("hex")
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-secure-"))
  process.env.PROXY_AUTH_DIR = dir
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    delete process.env.PROXY_AUTH_DIR
  })
  return dir
}
const entry = () => ({
  type: "oauth",
  access: token(),
  refresh: token(),
  expires: Date.now() + 3600000,
  subscriptionType: null,
  rateLimitTier: null,
})
test("strict expiry and metadata; access-only and refresh-only", (t) => {
  setup(t)
  for (const extra of [
    { expires: Infinity },
    { expires: 9e15 },
    { expires: "123" },
    { scopes: [{}] },
    { subscriptionType: {} },
    { rateLimitTier: [] },
  ])
    assert.throws(() => storage.normalizeAndSave({ ...entry(), ...extra }))
  assert.throws(() => storage.normalizeAndSave({ type: "oauth", access: token() }))
  assert.equal(storage.normalizeAndSave({ type: "oauth", refresh: token() }).expires, 0)
  assert.ok(storage.normalizeAndSave({ type: "oauth", access: token(), expires: Date.now() + 100000 }).access)
})
test("directory symlink rejected, oversized canonical rejected, status exact", (t) => {
  const dir = setup(t)
  const link = path.join(dir, "link")
  fs.symlinkSync(dir, link)
  process.env.PROXY_AUTH_DIR = link
  assert.throws(() => storage.ensureAuthDir())
  process.env.PROXY_AUTH_DIR = dir
  storage.write(entry())
  assert.deepEqual(
    Object.keys(storage.getStatus()).sort(),
    [
      "configured",
      "type",
      "provider",
      "expiresAt",
      "isExpired",
      "accessPresent",
      "refreshPresent",
      "accountIdPresent",
      "subscriptionType",
      "rateLimitTier",
    ].sort(),
  )
  fs.writeFileSync(storage.getAuthFile(), " ".repeat(65537))
  assert.equal(storage.read(), null)
})
test("atomic rename failure preserves credentials and cleans temporary file", (t) => {
  const dir = setup(t)
  storage.write(entry())
  const before = fs.readFileSync(storage.getAuthFile(), "utf8")
  const rename = fs.renameSync
  fs.renameSync = () => {
    throw Error("injected rename failure")
  }
  try {
    assert.throws(() => storage.write(entry()))
  } finally {
    fs.renameSync = rename
  }
  assert.equal(fs.readFileSync(storage.getAuthFile(), "utf8"), before)
  assert.deepEqual(fs.readdirSync(dir), ["auth.json"])
})
test("chmod errors fail closed and canonical symlink never followed", (t) => {
  const dir = setup(t)
  storage.write(entry())
  const before = fs.readFileSync(storage.getAuthFile(), "utf8")
  const chmod = fs.chmodSync
  fs.chmodSync = () => {
    throw Error("injected chmod failure")
  }
  try {
    assert.throws(() => storage.write(entry()))
    assert.equal(storage.read(), null)
  } finally {
    fs.chmodSync = chmod
  }
  assert.equal(fs.readFileSync(storage.getAuthFile(), "utf8"), before)
  const target = path.join(dir, "target.json")
  fs.renameSync(storage.getAuthFile(), target)
  fs.symlinkSync(target, storage.getAuthFile())
  assert.equal(storage.read(), null)
  assert.throws(() => storage.write(entry()))
  assert.equal(fs.readFileSync(target, "utf8"), before)
})
test("native seed rejects symlink source directory", async (t) => {
  const dir = setup(t)
  const source = path.join(dir, "source")
  fs.mkdirSync(source)
  fs.writeFileSync(
    path.join(source, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: token(), refreshToken: token(), expiresAt: Date.now() + 3600000 } }),
  )
  const link = path.join(dir, "claude")
  fs.symlinkSync(source, link)
  process.env.CLAUDE_CONFIG_DIR = link
  t.after(() => delete process.env.CLAUDE_CONFIG_DIR)
  for (const module of ["../dist/config/index.js", "../dist/services/auth.service.js"])
    delete require.cache[require.resolve(module)]
  await assert.rejects(require("../dist/services/auth.service").getAuth())
  assert.equal(storage.canonicalMissing(), true)
})
for (const change of ["import", "delete", "invalid", "symlink"])
  test(`pending refresh cannot resurrect or mix ${change}`, async (t) => {
    setup(t)
    storage.write({ ...entry(), expires: 0 })
    delete require.cache[require.resolve("../dist/services/auth.service")]
    const auth = require("../dist/services/auth.service")
    const oldFetch = global.fetch
    let resolve
    global.fetch = () => new Promise((r) => (resolve = r))
    t.after(() => {
      global.fetch = oldFetch
    })
    const pending = auth.getAuth()
    const replacement = entry()
    replacement.subscriptionType = "team"
    if (change === "import") storage.write(replacement)
    else if (change === "delete") fs.unlinkSync(storage.getAuthFile())
    else if (change === "symlink") {
      const target = path.join(process.env.PROXY_AUTH_DIR, "other.json")
      fs.renameSync(storage.getAuthFile(), target)
      fs.symlinkSync(target, storage.getAuthFile())
    } else fs.writeFileSync(storage.getAuthFile(), "{invalid")
    resolve({ ok: true, json: async () => ({ access_token: token(), expires_in: 3600 }) })
    if (change === "import") {
      assert.equal((await pending).accessToken, replacement.access)
      assert.deepEqual(storage.read(), replacement)
    } else {
      await assert.rejects(pending)
      assert.equal(storage.read(), null)
      await assert.rejects(auth.getAuth())
    }
  })
