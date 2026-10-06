const { test } = require("node:test")
const assert = require("node:assert/strict")
const { sendOpenAIError: sendToolError } = require("../dist/errors/proxy-error")
const { ProxyError: ToolError } = require("../dist/errors/proxy-error")
test("upstream rate limits are classified as rate limits, not malformed requests", () => {
  let status, body
  const res = {
    destroyed: false,
    headersSent: false,
    status(n) {
      status = n
      return this
    },
    json(x) {
      body = x
    },
  }
  sendToolError(res, new ToolError("limited", 429))
  assert.equal(status, 429)
  assert.equal(body.error.type, "rate_limit_error")
})
