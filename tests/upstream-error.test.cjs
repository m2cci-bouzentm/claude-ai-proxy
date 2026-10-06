const { test } = require("node:test")
const assert = require("node:assert/strict")
const { collectToolResponse, prepareToolRequest } = require("../dist/services/openai.service")
const { openAIRequestSchema: toolRequestSchema } = require("../dist/schemas/openai.schema")
const { sendOpenAIError: sendToolError } = require("../dist/errors/proxy-error")

const prepared = prepareToolRequest(
  toolRequestSchema.parse({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }] }),
)
const upstream = (status, body, headers = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
const anthropicError = (type, message) => ({ type: "error", error: { type, message } })

function capture(error) {
  const res = {
    headers: {},
    destroyed: false,
    headersSent: false,
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v
    },
    status(code) {
      this.code = code
      return this
    },
    json(body) {
      this.body = body
      return this
    },
  }
  sendToolError(res, error)
  return res
}

test("provider rejection reaches the client with its status and sanitized message", async () => {
  const error = await collectToolResponse(
    upstream(
      400,
      anthropicError("invalid_request_error", "messages.1.content.0: Invalid `signature` in `thinking` block"),
    ),
    prepared,
  ).catch((e) => e)
  const res = capture(error)
  assert.equal(res.code, 400)
  assert.deepEqual(res.body, {
    error: {
      message: "Anthropic rejected request (HTTP 400): messages.1.content.0: Invalid `signature` in `thinking` block",
      type: "invalid_request_error",
    },
  })
})

test("rate limits keep 429 and Retry-After; credential and overload failures become 502", async () => {
  const limited = capture(
    await collectToolResponse(
      upstream(429, anthropicError("rate_limit_error", "slow down"), { "retry-after": "12" }),
      prepared,
    ).catch((e) => e),
  )
  assert.equal(limited.code, 429)
  assert.equal(limited.headers["retry-after"], "12")
  assert.equal(limited.body.error.type, "rate_limit_error")
  for (const [status, text] of [
    [401, "Anthropic rejected the proxy credentials (HTTP 401): bad token"],
    [529, "Anthropic upstream failed (HTTP 529): Overloaded"],
  ]) {
    const res = capture(
      await collectToolResponse(
        upstream(status, anthropicError("x", status === 401 ? "bad token" : "Overloaded")),
        prepared,
      ).catch((e) => e),
    )
    assert.equal(res.code, 502)
    assert.deepEqual(res.body, { error: { message: text, type: "upstream_error" } })
  }
})

test("raw bodies and token-like values never reach the client", async () => {
  const raw = capture(await collectToolResponse(upstream(400, "secret raw upstream body"), prepared).catch((e) => e))
  assert.deepEqual(raw.body, {
    error: { message: "Anthropic rejected request (HTTP 400)", type: "invalid_request_error" },
  })
  const leaky = capture(
    await collectToolResponse(
      upstream(400, anthropicError("invalid_request_error", "bad Bearer sk-ant-oat01-abcdefghijklmnop header")),
      prepared,
    ).catch((e) => e),
  )
  assert.doesNotMatch(leaky.body.error.message, /sk-ant|abcdefghijklmnop/)
})
