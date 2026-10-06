"use strict"
// Test-only local HTTP provider; real auth service and outgoing Authorization retained.
const http = require("node:http")
const fs = require("node:fs")
const realFetch = global.fetch
http
  .createServer((req, res) => {
    req.resume()
    req.on("end", () => {
      fs.appendFileSync(
        "/tmp/auth-provider.jsonl",
        JSON.stringify({ pid: process.pid, authorization: req.headers.authorization, path: req.url }) + "\n",
      )
      res.setHeader("content-type", "application/json")
      res.end(
        JSON.stringify({
          id: "msg_local",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "LOCAL_AUTH_OK" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      )
    })
  })
  .listen(4199, "127.0.0.1")
global.fetch = (url, options) => realFetch("http://127.0.0.1:4199" + new URL(url).pathname, options)
