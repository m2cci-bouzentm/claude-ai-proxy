# claude-ai-proxy

OpenAI-compatible API proxy that routes through your Claude Code subscription (Max/Pro) instead of API credits.

## Setup

**1. Get auth credentials** — ensure `~/.claude/.credentials.json` exists locally:

- **Linux**: already there after `claude` login
- **macOS**: run `./extract-keychain.sh` to extract from Keychain to file

Then deploy to VPS:

```bash
./deploy-auth.sh 'ssh -i ~/.ssh/key user@host'
```

**2. Configure and start** on VPS:

```bash
cp .env.example .env    # set API_KEY, ACCOUNT_UUID, DEVICE_ID
docker compose up -d --build
```

On first start, the proxy seeds from `~/.claude/.credentials.json` and writes its own copy to `/data/auth.json`. From then on, it manages token refresh automatically — the credentials file is deleted after seeding.

**Re-auth** — only needed if the refresh token dies. Extract fresh credentials, copy to VPS, then `rm ./data/auth.json && docker restart claude-ai-proxy` to force re-seed.

## API

```bash
curl http://your-vps:4181/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-sonnet-4-6", "messages": [{"role": "user", "content": "Hello"}]}'
```

Works with any OpenAI SDK — just change `base_url` to `http://your-vps:4181/v1`.

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | No | Token status and subscription info |
| GET | `/v1/models` | No | List available models |
| POST | `/v1/chat/completions` | Yes | OpenAI-compatible completions (streaming supported) |
| GET | `/tools/v1/models` | No | Same model list for tool-capable clients |
| POST | `/tools/v1/chat/completions` | Yes | Opt-in native tool calling, JSON or buffered SSE |

### Tool-capable clients (Hermes, OpenAI SDK)

Use `http://your-vps:4181/tools/v1` as the client's base URL, with the same API key
and model. Existing clients keep `http://your-vps:4181/v1`; the original request
conversion, response format, streaming and authentication behavior are unchanged.

```bash
curl http://your-vps:4181/tools/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"Echo hello using the tool."}],"tools":[{"type":"function","function":{"name":"echo","parameters":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}}}],"tool_choice":"required"}'
```

The response contains `message.tool_calls` and `finish_reason: "tool_calls"`.
The client executes the tool, appends that assistant message plus one
`{"role":"tool","tool_call_id":"...","content":"..."}` per call, and sends the
updated conversation to the same endpoint. The proxy never executes tools.

- `tool_choice`: `auto`, `none`, `required`, or a named function; optional
  `parallel_tool_calls: false` limits the turn to one call.
- Full draft-07 parameter schemas are forwarded and validated with **Ajv**.
  No type coercion, argument repair, remote schema fetching, or prose scanning.
  Unknown tools and invalid arguments fail with an error rather than executing.
- Consumer system/developer instructions are preserved as a labeled user-level
  context block at the start of the conversation. They are never appended to
  Anthropic's `system` field, which contains only the proxy's bundled prompt.
  User messages and native tool-result IDs are preserved on this route.
- `stream: true` returns OpenAI SSE, with stable IDs, indexed calls, finish reason,
  `[DONE]`, and optional `stream_options.include_usage`. The whole upstream turn
  is buffered before emitting SSE so all calls can be validated first. This adds
  time to the first emitted chunk; it is not live token streaming.
- Requests are limited to 32 MiB (to accommodate 1M-token contexts), upstream responses to 8 MiB, and upstream time to
  120 seconds. Client disconnects abort the new route's upstream request.
- Text messages only; `n=1`. `response_format` and legacy `functions`/`function_call`
  are rejected. Adaptive thinking is not enabled on this route because forced
  tool selection is incompatible with it. Existing-route thinking is unchanged.

The standard API IDs `claude-opus-4-6`, `claude-opus-4-8`, `claude-opus-5`, and
`claude-fable-5-1` support 1M context by default; no `[1m]` suffix or beta header is
needed. Set the client's context length to `1000000`. See
[Anthropic's context documentation](https://platform.claude.com/docs/en/build-with-claude/context-windows).
Model capabilities are validated by upstream; the proxy has no model-specific
tool-choice restrictions. Signed thinking blocks, when returned, are preserved as
`reasoning_details` in JSON and SSE and must be replayed unchanged by the client.
The opt-in route uses the 2.1.251 client protocol identity;
the existing route retains its previous identity and behavior. Model availability
still depends on the authenticated account, and the model's token limit applies
independently of the HTTP byte limit.

Implementation references: [ToolBridge](https://github.com/Oct4Pie/toolbridge)
demonstrates an isolated tool translation layer, and
[LLM-Rosetta](https://github.com/Oaklight/llm-rosetta) separates provider formats.
Their text-emulation/parsing code is unnecessary here: this proxy already calls
Claude's native Messages API. Instead, the existing **official Anthropic SDK**
handles SSE decoding, stream errors, incremental JSON and message assembly.
**Zod** validates and normalizes incoming requests into typed data; **Ajv** validates
caller-provided draft-07 tool schemas and generated arguments. Custom code is limited to request/response mapping,
tool-choice checks and the Express route. No additional LLM service is involved.

Run `npm test` for route, compatibility, schema, streaming and cancellation tests.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `API_KEY` | required | Secures proxy endpoint |
| `DEFAULT_MODEL` | `claude-sonnet-4-6` | Fallback model |
| `PORT` | `4181` | Internal container port |
| `CLAUDE_PROXY_HOME` | `/data` | Auth storage directory |
| `ACCOUNT_UUID` | required | Claude account UUID |
| `DEVICE_ID` | required | Device ID hex string |
| `SYSTEM_PROMPT_PATH` | `/data/system_prompt.json` | CLI system prompt file |
| `TOOL_PROMPT_CACHE_TTL` | `5m` | Automatic conversation caching on `/tools/v1` only: `5m`, `1h`, or `off` |

### Prompt caching on the tool endpoint

The proxy adds Anthropic's top-level automatic `cache_control` to reuse the growing
conversation prefix across turns. The system prompt still comes only from
`SYSTEM_PROMPT_PATH`, with its existing cache markers and established client-version
preamble handling. Caching adds no prompt text and does not change message roles:
consumer system/developer instructions remain user-level context by design.

The bundled prompt has two one-hour cache markers; automatic caching uses a third
of Anthropic's four available slots. Its default five-minute lifetime suits active
tool loops and can follow the earlier one-hour markers. Custom prompt files must
leave a slot available and respect Anthropic's longest-TTL-first ordering.
Client-supplied cache markers are not forwarded; the server owns this policy.
Set `TOOL_PROMPT_CACHE_TTL=off` to disable conversation caching while retaining the
file's existing system caches. The legacy `/v1` endpoint is unaffected.

JSON and SSE usage (when `stream_options.include_usage` is true) expose
`prompt_tokens_details.cached_tokens` and `prompt_tokens_details.cache_write_tokens`.
`prompt_tokens` includes uncached input, cache reads, and cache writes exactly once.
Cache hits require a matching prefix; changing earlier tools/instructions or
compacting history can reduce hits. Responses and tool results are never memoized.
API cache pricing is not a guarantee of equivalent subscription allowance savings.

## Security note

Claude Code's subscriber-tier API access is gated by the presence of the CLI system prompt in the request body — not by cryptographic signing or token scoping. The system prompt is shipped in plaintext inside the compiled CLI binary, making it trivially extractable. It functions as a shared secret in cleartext.

### Image input on the tool endpoint

User messages and tool results accept OpenAI content arrays containing `text` and
`image_url` parts. Images are converted to native Anthropic image blocks, preserving
order. Use base64 data URLs (JPEG, PNG, GIF or WebP, up to 5 MiB per image) or HTTP(S)
URLs that Anthropic can access. The proxy does not download URLs or read local paths.
OpenAI `detail` values are accepted but have no direct native equivalent and are
not forwarded. Images are input only; assistant responses remain text/tool calls.
The 32 MiB total request limit still applies. System/developer messages remain
text-only and are moved to user-level context as described above.
