"use strict"
const { test } = require("node:test")
const assert = require("node:assert/strict")
const { assertUsage } = require("./e2e-cases.cjs")
for (const protocol of ["openai", "anthropic"]) {
  test(`${protocol} HTTP cache/usage assertions reject absent and zero counters`, () => {
    const usage =
      protocol === "openai"
        ? { prompt_tokens: 80, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 4096 } }
        : { input_tokens: 80, output_tokens: 8, cache_read_input_tokens: 4096 }
    assertUsage({ usage }, protocol, true)
    assert.throws(() => assertUsage({}, protocol, true), /usage missing/)
    const missing = structuredClone(usage)
    if (protocol === "openai") delete missing.prompt_tokens_details
    else delete missing.cache_read_input_tokens
    assert.throws(() => assertUsage({ usage: missing }, protocol, true), /cache usage missing\/zero/)
    const zero = structuredClone(usage)
    if (protocol === "openai") zero.prompt_tokens_details.cached_tokens = 0
    else zero.cache_read_input_tokens = 0
    assert.throws(() => assertUsage({ usage: zero }, protocol, true), /cache usage missing\/zero/)
    for (const field of protocol === "openai"
      ? ["prompt_tokens", "completion_tokens"]
      : ["input_tokens", "output_tokens"]) {
      const bad = structuredClone(usage)
      delete bad[field]
      assert.throws(() => assertUsage({ usage: bad }, protocol), /usage missing\/zero/)
    }
  })
}
