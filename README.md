# claude-ai-proxy

OpenAI-compatible API proxy that uses your Claude Code subscription (Max/Pro/Team/Enterprise) instead of API credits. Calls `api.anthropic.com/v1/messages` directly using OAuth tokens. Auth is managed in its own file (`~/.claude-proxy/auth.json`), seeded from Claude Code's macOS Keychain on first run - no token rotation conflicts.

## Security note

Claude Code's subscriber-tier API access is gated by the presence of the CLI system prompt in the request body - not by cryptographic signing, token scoping, or any server-side entitlement check on the OAuth token itself.

A valid OAuth bearer token alone returns `429` on all non-Haiku models. The same token with the CLI system prompt appended succeeds immediately. The system prompt is shipped in plaintext inside the compiled CLI binary, making it trivially extractable.

In practice, this means the system prompt functions as a **shared secret in cleartext** - the only barrier between a raw API call and full subscriber access. A more conventional approach would sign requests with a key stored in the OS keychain, or scope subscriber entitlements directly on the token so that the request body has no bearing on authorization.

## Setup

1. Run `claude` on a machine with a browser to log in (populates macOS Keychain)
2. Copy `.env.example` to `.env` and set your `API_KEY` (used to secure the proxy endpoint)
3. Run `npm install && npm run build && npm start`, or with Docker: `docker compose up -d`
4. Send requests to `POST /v1/chat/completions` with the same format as the OpenAI API

## How it works

```
Client (OpenAI SDK)  →  claude-ai-proxy (:4181)  →  api.anthropic.com/v1/messages
                         ↕
                    ~/.claude-proxy/auth.json
                    (seeded from macOS Keychain)
```

- On first request, reads OAuth tokens from macOS Keychain (`Claude Code-credentials`)
- Stores them in `~/.claude-proxy/auth.json` (isolated from Claude CLI - no conflicts)
- Auto-refreshes via `platform.claude.com/v1/oauth/token` when expired
- Falls back to re-seeding from Keychain if refresh fails

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /v1/chat/completions` | OpenAI-compatible (drop-in replacement) |
| `GET /v1/models` | List available models |
| `GET /health` | Token status and subscription info |

## Usage

```bash
# Direct curl
curl http://localhost:4181/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-sonnet-4-6", "messages": [{"role": "user", "content": "Hello!"}]}'

# OpenAI SDK
from openai import OpenAI
client = OpenAI(api_key="your-proxy-key", base_url="http://localhost:4181/v1")
client.chat.completions.create(model="claude-sonnet-4-6", messages=[{"role": "user", "content": "Hello!"}])
```

## Auth details

| Field | Value |
|-------|-------|
| Token URL | `https://platform.claude.com/v1/oauth/token` |
| Client ID | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` |
| API endpoint | `https://api.anthropic.com/v1/messages` |
| Auth header | `Authorization: Bearer sk-ant-oat01-...` |
| API version | `anthropic-version: 2023-06-01` |
| Keychain service | `Claude Code-credentials` |
