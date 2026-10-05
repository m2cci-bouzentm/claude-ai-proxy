# claude-ai-proxy

OpenAI-compatible API proxy that routes through your Claude Code subscription (Max/Pro) instead of API credits. Unified `/openai/v1` supports text, native tools, images, and prompt caching. `/anthropic` exposes native Claude Code endpoints with centralized OAuth. Old `/v1` and `/tools/v1` roots are removed.

## Setup & Authentication

Authentication is unified across `/data/auth.json` inside Docker. Compose sets
`PROXY_AUTH_DIR=/data` and mounts `${PROXY_AUTH_VOLUME:-claude-proxy-data}` there.
`PROXY_AUTH_VOLUME` controls the host volume source (named volume by default, or
an absolute private host directory); it is independent of `PROXY_AUTH_DIR`.
Do not set `PROXY_AUTH_VOLUME=/data` unless you explicitly want that host path.
For local CLI use, set `PROXY_AUTH_DIR` to a private user-owned directory.

Credentials are managed using the `proxy-auth` CLI. Status/import/login results
are JSON-only on stdout; native login prompts and diagnostics go to stderr, with
stdin attached for interactive codes. Browser login is the native default;
`--sso`, `--console`, and `--email` are forwarded. The child receives a minimal
terminal/browser environment, not inherited API keys, provider settings, proxy
secrets, or Node injection options. Imports accept at most 64 KiB, reject symlinks
and non-regular files, and report malformed JSON without credential excerpts.
Inside the running container, execute one command:

```bash
proxy-auth login
```
Interactive menu offers browser login, SSO login, Anthropic Console login, or
hidden field-by-field token paste. `proxy-auth import` opens the token-paste
wizard directly and asks for access token, refresh token, and expiry one by one.
Access-only and refresh-only transfers work; at least one token is required.
JSON file/stdin forms remain available only for automation. Run
`proxy-auth status` to inspect redacted credential metadata.

Example inputs shown by the wizard: access `<Claude-access-token>`, refresh
`<Claude-refresh-token>`, and expiry `2026-10-05T15:24:26Z` (epoch seconds/ms
also accepted). Leave access blank for refresh-only; leave refresh blank for
access-only. Browser/SSO/Console choices explain that users complete the shown
authorization URL and paste a returned code only when native Claude CLI asks.

The running server automatically reloads credentials when `/data/auth.json` is updated, without needing a restart. Seeding from local Claude credentials is completely non-destructive (never deletes source files).

## API

```bash
curl http://localhost:4181/openai/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-sonnet-4-6", "messages": [{"role": "user", "content": "Hello"}]}'
```

Works with any OpenAI SDK — just change `base_url` to `http://localhost:4181/openai/v1`.

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | No | Proxy health |
| GET | `/openai/v1/models` | No | OpenAI model discovery |
| POST | `/openai/v1/chat/completions` | Yes | Unified text/tools/images/caching |
| POST | `/anthropic/v1/messages` | Yes | Native Messages and incremental SSE |
| POST | `/anthropic/v1/messages/count_tokens` | Yes | Native token counting |

| GET | `/anthropic/v1/models` | Yes | Upstream model discovery/pagination |
| GET | `/anthropic/v1/models/:model` | Yes | Upstream model details |
| GET | `/anthropic/api/oauth/usage` | Yes | Central account usage/limits |
| GET | `/anthropic/api/oauth/profile` | Yes | Central account profile |
| HEAD | `/anthropic/api/hello` | Yes | Claude Code gateway probe |

Native cache annotations, TTLs, token usage, cache-read/write counters, and SSE
pass through unchanged. No local completion-response cache.

### Native Claude Code gateway

```bash
export ANTHROPIC_BASE_URL="http://localhost:4181/anthropic"
export ANTHROPIC_AUTH_TOKEN="$PROXY_API_KEY"
claude
```

Claude Code appends `/v1/messages`; do not include `/v1` in this base URL.
`POST /anthropic/v1/messages` accepts Bearer or `x-api-key` proxy authentication,
replaces it with centralized server OAuth, and preserves native system prompts,
tools, thinking, cache markers, metadata, and other request fields. Native SSE
passes through incrementally; JSON and upstream error status/bodies remain native.
The gateway merges OAuth/Claude Code beta headers with client betas. Messages, token counting, cache touch, models, usage/profile, and gateway probe
are implemented. Files, batches, cloud sessions, MCP connectors, and account
management APIs are not proxied; this is not a full claude.ai backend replacement. Upstream OAuth acceptance and account subscription limits still apply.
Automated tests use a local fake upstream; real multi-device Claude Code/OAuth
inference has not been smoke-tested. Client-supplied metadata is preserved.
Redirects are rejected. Buffered upstream responses are limited to 32 MiB.
`ANTHROPIC_TIMEOUT_MS` defaults to 120000: first-response/body deadline and
stream idle timeout, refreshed on each streamed chunk.
Use HTTPS or private networking for remote access; never expose an unprotected
proxy. `/tools/v1` has been removed; migrate clients to `/openai/v1`.

### Tool-capable clients (Hermes, OpenAI SDK)

Use `http://localhost:4181/openai/v1` as the client's base URL, with the same API key
and model. Migrate all OpenAI clients to this unified endpoint; separate text-only route is removed.

```bash
curl http://localhost:4181/openai/v1/chat/completions \
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
  `[DONE]`, and optional `stream_options.include_usage`. Text requests without
  tool definitions emit text deltas live through this same unified handler.
  Tool turns remain buffered until executable calls validate. Text-only,
  non-Haiku requests retain adaptive thinking; forced tool calls never enable it.
- Requests are limited to 32 MiB (to accommodate 1M-token contexts), upstream responses to 8 MiB, and upstream time to
  120 seconds. Client disconnects abort the new route's upstream request.
- Text and image content in user/tool messages; `n=1`. `response_format` and legacy `functions`/`function_call`
  are rejected. Adaptive thinking is not enabled on this route because forced
  tool selection is incompatible with it. Native Anthropic thinking passes through unchanged.

### Model names and context budgets

Both model-list endpoints publish bare model names with a `context_length` preset
of `200000`, plus separate `-1m` aliases with a preset of `1000000` for these models:

- `claude-opus-4-6`, `claude-opus-4-7`, `claude-opus-4-8`, `claude-opus-5`, `claude-opus-5-5`
- `claude-sonnet-4-6`, `claude-sonnet-5`
- `claude-fable-5`, `claude-fable-5-1`

For example, choose `claude-fable-5-1-1m` for the 1M preset. Sonnet 4.5 and
Haiku 4.5 have 200K windows and have no `-1m` aliases.

These are proxy aliases and client budgets, not separate upstream models or
server-enforced limits. Anthropic provides a native 1M window for the supported
models under their bare IDs; the proxy resolves each registered alias to that ID
without an extra beta header. Existing bare-name requests retain their behavior.
See [Anthropic's context documentation](https://platform.claude.com/docs/en/build-with-claude/context-windows).

Clients must honor discovery metadata or configure their context budget explicitly.
In Hermes, set per-model `context_length` values in the custom provider's `models`
configuration, for example:

```yaml
models:
  claude-fable-5-1:
    context_length: 200000
  claude-fable-5-1-1m:
    context_length: 1000000
```

You can change these client budgets to another value within the native model limit.
`max_tokens` and `max_completion_tokens` control output length, not context size.
Unified OpenAI inference endpoint accepts bodies up to 32 MiB.

Model capabilities are validated by upstream; the proxy has no model-specific
tool-choice restrictions. Signed thinking blocks, when returned, are preserved as
`reasoning_details` in JSON and SSE and must be replayed unchanged by the client.
Both routes present the Claude Code 2.1.280 client identity (User-Agent and
billing header), which upstream requires for the newest models. Model availability
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

### Model refusals

An upstream refusal returns `finish_reason: "content_filter"` on the tool endpoint.
`message.refusal` contains the upstream explanation, or a generic message when none
is supplied. `message.refusal_details` preserves the native category and explanation;
SSE exposes the same fields in `delta`. Partial text, reasoning, and tool calls from
a refused turn are discarded. Usage and cache accounting are still reported.

These rules apply to every model. The proxy does not silently switch models or
rewrite prompts to avoid a refusal. Fable 5 can refuse benign Hermes tasks: a
file-reading probe returned the upstream `cyber` category while smaller native
tool/cache probes passed. See [Anthropic's refusal documentation](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback).

Run `npm test` for route, compatibility, schema, streaming and cancellation tests.

## Architecture

## Architecture & Shared Contract

The Express application separates routing, validation, and business logic into canonical layers matching the shared proxy architecture:

```text
src/
  config/       Environment settings, Zod env parsing, and model catalog
  routes/       Canonical endpoint registration (openai.ts, anthropic.ts, health.ts, models.ts)
  middleware/   API key authentication and Zod boundary validation (auth.ts, validate.ts)
  controllers/  HTTP request/response lifecycle, streaming, and cancellation (openai.controller.ts)
  services/     OpenAI conversation handling, native Anthropic gateway, and OAuth lifecycle
  schemas/      Zod 4.3.6 boundary contracts (openai.schema, anthropic.schema, auth.schema, provider.schema, config.schema)
  types/        Shared contracts and schema-inferred TypeScript types
  lib/          Claude transport, image conversion, and secure credential storage
  jobs/         Proactive OAuth token refresh cron jobs
  errors/       Domain errors with protocol-safe error mapping
  utils/        Request cancellation and error handling helpers
  index.ts      Server bootstrap and router composition
```

All inbound requests across `/openai/v1` and `/anthropic`, environment variables at startup, auth storage files, and token wizard inputs are validated at the boundaries using Zod (v4.3.6). Tool argument schemas provided by callers continue to use Draft 2020-12 validation via Ajv 2020. Unmounted legacy routes and controllers have been removed; obsolete `/v1` and `/tools/v1` remain removed.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `API_KEY` | required | Secures proxy endpoint |
| `DEFAULT_MODEL` | `claude-sonnet-4-6` | Fallback model |
| `PORT` | `4181` | Internal container port |
| `PROXY_AUTH_DIR` | `/data` in Docker | Container/local auth storage directory |
| `PROXY_AUTH_VOLUME` | `claude-proxy-data` | Compose host volume source mounted at `/data` |
| `CLAUDE_PROXY_HOME` | `/data` | Legacy auth storage fallback |
| `ACCOUNT_UUID` | required | Claude account UUID |
| `DEVICE_ID` | required | Device ID hex string |
| `SYSTEM_PROMPT_PATH` | `/data/system_prompt.json` | CLI system prompt file |
| `TOOL_PROMPT_CACHE_TTL` | `5m` | Automatic conversation caching on `/openai/v1` only: `5m`, `1h`, or `off` |

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
file's existing system caches. Old `/v1` endpoint has been removed.

JSON and SSE usage (when `stream_options.include_usage` is true) expose
`prompt_tokens_details.cached_tokens` and `prompt_tokens_details.cache_write_tokens`.
`prompt_tokens` includes uncached input, cache reads, and cache writes exactly once.
Cache hits require a matching prefix; changing earlier tools/instructions or
compacting history can reduce hits. Responses and tool results are never memoized.
API cache pricing is not a guarantee of equivalent subscription allowance savings.

## OpenCode verification

OpenCode 1.14.39 sends Draft 2020-12 tool schemas on every request. A live run exposed draft-07-only validation; regression now covers OpenCode-style `$schema`/`$defs`, and validation uses Ajv 2020. OpenAI system/developer messages are appended after the immutable server billing prompt, preserving caller authority without allowing replacement. Live Docker verification passed text, completed Bash tool execution, and four cache probes with `14941, 17244, 17244, 17244` cache-read tokens. Claude Code through `/anthropic` also completed a real Bash `tool_use`/`tool_result` roundtrip.

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
