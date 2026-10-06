#!/usr/bin/env node
"use strict"
const { runCases } = require("../tests/e2e-cases.cjs")
if (!process.env.E2E_BASE_URL || !process.env.E2E_API_KEY) {
  console.error("Set E2E_BASE_URL and E2E_API_KEY. Runner sends inference requests to supplied endpoint.")
  process.exit(2)
}
runCases({
  baseURL: process.env.E2E_BASE_URL,
  apiKey: process.env.E2E_API_KEY,
  model: process.env.E2E_MODEL || "claude-sonnet-4-6",
  session: process.env.E2E_SESSION || `http-e2e-${Date.now()}`,
  report: (result) => console.log(JSON.stringify(result)),
})
  .then((result) => console.log(JSON.stringify(result)))
  .catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
