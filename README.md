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

## Security note

Claude Code's subscriber-tier API access is gated by the presence of the CLI system prompt in the request body — not by cryptographic signing or token scoping. The system prompt is shipped in plaintext inside the compiled CLI binary, making it trivially extractable. It functions as a shared secret in cleartext.
