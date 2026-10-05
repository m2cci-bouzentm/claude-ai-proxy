# HTTP integration regression and live verification

Run from repository root:

```sh
cd /home/mohamed/projects/claude-ai-proxy
npm test
node scripts/e2e-docker-regression.cjs
```

`npm test` includes real loopback HTTP integration against compiled server, with provider transport mocked by a test-only Node preload. Docker runner builds production Dockerfile and runs same HTTP cases inside uniquely named `hermes-claude-regression-*` container. Container uses `--network none`, no published ports, no host credentials, and synthetic test prompt/auth. HTTP client runs via `docker exec` against container loopback with preload disabled. Existing containers/services remain untouched; only runner's own container/image are removed. Image builds may require package/base-image downloads.

Docker startup currently fails on this host with containerd shim API mismatch: `shim was started through the deprecated API but was built against the new API`. This is host runtime failure, not passing Docker verification. Do not restart shared Docker/containerd services without approval. Local HTTP integration remains independently runnable through `npm test`.

## Actual live attempt, 2026-10-05

Production image `hermes-claude-e2e-20261005` built successfully. Live container `hermes-claude-e2e-20261005` could not start: same containerd shim API mismatch above. All 11 live endpoint checks, provider cache counters, Claude Code text and Bash tool-result proof remain **blocked**, not passed. No external inference occurred. Secured copies of both original credential files were mounted read-only outside build context; originals untouched. Installed Claude Code 2.1.287 bounded isolated CLI attempt against unavailable loopback target timed out after 20 seconds; this is not container CLI verification. Installed Codex 0.157.1 rejected `wire_api = "chat"` before network, exit 1. No Responses endpoint added.

Reusable opt-in live container command:

```sh
E2E_ALLOW_REAL_INFERENCE=1 node scripts/e2e-docker-live.cjs
```

Launcher builds image, copies credentials into mode-0700 temporary directory outside repo, mounts copies read-only, publishes ephemeral loopback port, waits for health, runs shared HTTP cases, retains container/copies for inspection. It never prints auth contents. If token refresh needs writes, explicitly supply a writable copy instead; never mount originals writable. Remove retained test containers and copies manually after verification. Provider failures are failures, never cache proof.

## Shared cases / live runner

- Shared implementation: `tests/e2e-cases.cjs`, exports `runCases({baseURL, apiKey, model, session, report})`, `assertUsage`, `parseSSE`.
- Live entry point: `scripts/e2e-http.cjs`. It never imports provider mock and requires explicit endpoint/key. Use only when real inference is authorized; requests consume provider capacity.
- Regression-only mock: `tests/provider-mock.cjs`. Never preload it for live verification. Its generated counters test mapping/transport, **not proof of real provider caching**.

```sh
E2E_BASE_URL=http://127.0.0.1:4181 \
E2E_API_KEY="$PROXY_API_KEY" \
E2E_MODEL=claude-sonnet-4-6 \
E2E_SESSION=http-live-stable-session \
node scripts/e2e-http.cjs
```

Runner prints actual repeated response usage without key or prompt content. Stable session header is sent on every request; native forwarding is separately checked in regression captures. OpenAI transport currently generates provider identity internally, so caller's stable header alone does not prove stable upstream OpenAI identity.

## Coverage

Exactly 11 method/routes:

1. GET `/health`
2. GET `/openai/v1/models`
3. POST `/openai/v1/chat/completions`
4. POST `/anthropic/v1/messages`
5. POST `/anthropic/v1/messages/count_tokens`
6. GET `/anthropic/v1/models`
7. GET `/anthropic/v1/models/:model`
8. GET `/anthropic/api/oauth/usage`
9. GET `/anthropic/api/oauth/profile`
10. HEAD `/anthropic/api/hello`

Removed `/anthropic/v1/messages/cache_touch` is asserted as 404 because live upstream does not support it.

Both protocols: JSON text, text SSE, inline PNG, forced tool call, tool-result continuation, streamed tool arguments, long-prefix cache warmup followed by **two** identical repeats. Cache checks require positive finite OpenAI `usage.prompt_tokens_details.cached_tokens` / Anthropic `usage.cache_read_input_tokens`; input/output counters must also be positive. No fallback estimates, relaxed zero assertions, or live synthetic usage. Negative unit checks prove absent usage, absent/zero cache, and absent input/output counters fail. Native count_tokens requires positive provider response; OAuth usage requires finite utilization.

Live provider/account may reject administrative endpoints, model IDs, or return zero cache after warmup. Runner fails rather than skipping these requirements. Provider cache behavior and upstream session identity must be confirmed with real inference separately.

## Live rerun after Docker repair

Container startup and credential-copy loading passed. Health, both model lists,
model lookup, token counting, OAuth usage/profile and hello returned 200. Live
upstream confirmed `/cache_touch` unsupported (404), so route was removed and a
404 regression added. Both inference endpoints and isolated Claude Code returned
429 because account weekly utilization was 100%; reset reported by provider:
2026-10-05T15:00:00Z. Therefore real prompt-cache counters, images, tools and
Claude Code tool execution remain blocked by provider quota, not marked passed.
