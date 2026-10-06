import { once } from "events"
import type { Request, Response } from "express"
import crypto from "crypto"
import { getAuth } from "./auth.service"
import { config } from "../config"
import { resolveModelId } from "../config/models"
import { createRequestCancellation } from "../utils/abort"
import {
  anthropicMessagesRequestSchema,
  anthropicCountTokensRequestSchema,
  anthropicModelsQuerySchema,
} from "../schemas/anthropic.schema"
import {
  upstreamCountTokensResponseSchema,
  upstreamEventSchema,
  upstreamMessageSchema,
  upstreamModelSchema,
  upstreamModelsResponseSchema,
} from "../schemas/provider.schema"

const UPSTREAM_ANTHROPIC_URL = process.env.ANTHROPIC_UPSTREAM_URL || "https://api.anthropic.com/v1/messages?beta=true"

import { ANTHROPIC_BETAS as DEFAULT_BETAS } from "../lib/anthropic-betas"

function validateSuccessfulJson(pathname: string, raw: Buffer): void {
  let payload: unknown
  try {
    payload = JSON.parse(raw.toString("utf8"))
  } catch {
    throw new Error("Invalid upstream JSON")
  }
  const schema =
    pathname === "/v1/messages"
      ? upstreamMessageSchema
      : pathname === "/v1/messages/count_tokens"
        ? upstreamCountTokensResponseSchema
        : pathname === "/v1/models"
          ? upstreamModelsResponseSchema
          : pathname.startsWith("/v1/models/")
            ? upstreamModelSchema
            : null
  if (schema && !schema.safeParse(payload).success) throw new Error("Invalid upstream response")
}

function validateSseFrame(frame: string): void {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
  if (!data || data === "[DONE]") return
  let payload: unknown
  try {
    payload = JSON.parse(data)
  } catch {
    throw new Error("Invalid upstream stream JSON")
  }
  if (!upstreamEventSchema.safeParse(payload).success) throw new Error("Invalid upstream stream event")
}

export async function proxyAnthropicMessages(req: Request, res: Response): Promise<void> {
  const cancellation = createRequestCancellation(res)
  const configuredTimeout = Number(process.env.ANTHROPIC_TIMEOUT_MS ?? 120_000)
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 120_000
  let timeout: ReturnType<typeof setTimeout> | undefined
  const resetTimeout = () => {
    clearTimeout(timeout)
    timeout = setTimeout(() => cancellation.abort(), timeoutMs)
    timeout.unref()
  }
  try {
    let incomingBody: Record<string, unknown> = req.body ?? {}
    const isMessages = req.path === "/v1/messages"
    const isCountTokens = req.path === "/v1/messages/count_tokens"
    if (req.path === "/v1/models" && !anthropicModelsQuerySchema.safeParse(req.query).success) {
      res.status(400).json({ type: "error", error: { type: "invalid_request_error", message: "Invalid model query" } })
      return
    }

    if (isMessages || isCountTokens) {
      const schema = isMessages ? anthropicMessagesRequestSchema : anthropicCountTokensRequestSchema
      const parsed = schema.safeParse(incomingBody)
      if (!parsed.success) {
        res.status(400).json({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "messages is required and must be an array",
          },
        })
        return
      }
      incomingBody = parsed.data
    }

    resetTimeout()
    const auth = await getAuth()
    const resolvedModel = typeof incomingBody.model === "string" ? resolveModelId(incomingBody.model) : undefined

    const forwardBody: Record<string, unknown> = {
      ...incomingBody,
      ...(resolvedModel ? { model: resolvedModel } : {}),
    }

    if (isMessages && (!forwardBody.metadata || typeof forwardBody.metadata !== "object")) {
      forwardBody.metadata = {
        user_id: JSON.stringify({
          device_id: config.deviceId,
          account_uuid: config.accountUuid,
          session_id: crypto.randomUUID(),
        }),
      }
    }

    // Outbound headers: replace inbound auth with centralized server OAuth token
    const outboundHeaders: Record<string, string> = {
      Authorization: `Bearer ${auth.accessToken}`,
      "Content-Type": "application/json",
      "anthropic-version": (req.headers["anthropic-version"] as string) || "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "x-app": (req.headers["x-app"] as string) || "cli",
      "User-Agent": (req.headers["user-agent"] as string) || "claude-cli/2.1.287 (external, sdk-cli)",
      "x-client-request-id": (req.headers["x-client-request-id"] as string) || crypto.randomUUID(),
    }

    // Forward stainless headers
    for (const [key, value] of Object.entries(req.headers)) {
      const lower = key.toLowerCase()
      if ((lower.startsWith("x-stainless-") || lower === "x-claude-code-session-id") && typeof value === "string") {
        outboundHeaders[key] = value
      }
    }

    // Merge incoming betas with DEFAULT_BETAS, deduplicated
    const incomingBetaStr = req.headers["anthropic-beta"]
    const betaSet = new Set<string>(DEFAULT_BETAS)
    if (typeof incomingBetaStr === "string") {
      for (const b of incomingBetaStr.split(",")) {
        const trimmed = b.trim()
        if (trimmed) betaSet.add(trimmed)
      }
    }
    outboundHeaders["anthropic-beta"] = Array.from(betaSet).join(",")

    const upstreamUrl = new URL(req.path + req.url.slice(req.path.length), new URL(UPSTREAM_ANTHROPIC_URL).origin)
    if (isMessages && !upstreamUrl.searchParams.has("beta")) upstreamUrl.searchParams.set("beta", "true")
    const upstreamResp = await fetch(upstreamUrl, {
      method: req.method,
      redirect: "error",
      headers: outboundHeaders,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : JSON.stringify(forwardBody),
      signal: cancellation.signal,
    })

    if (res.destroyed) return

    // Forward status code
    res.status(upstreamResp.status)

    // Forward safe response headers
    for (const [key, value] of upstreamResp.headers.entries()) {
      const lower = key.toLowerCase()
      if (
        lower.startsWith("anthropic-") ||
        lower === "content-type" ||
        lower === "cache-control" ||
        lower === "retry-after" ||
        lower === "request-id" ||
        lower === "x-accel-buffering" ||
        lower.startsWith("x-ratelimit-")
      ) {
        res.setHeader(key, value)
      }
    }

    const isStream = Boolean(incomingBody.stream)
    const contentType = upstreamResp.headers.get("content-type") || ""

    // If not streaming or upstream error or non-SSE response, return buffer
    if (!upstreamResp.ok || !isStream || !contentType.includes("text/event-stream")) {
      const chunks: Buffer[] = []
      let bytes = 0
      if (upstreamResp.body) {
        for await (const chunk of upstreamResp.body as unknown as AsyncIterable<Uint8Array>) {
          bytes += chunk.length
          if (bytes > 32 * 1024 * 1024) throw new Error("Upstream response too large")
          chunks.push(Buffer.from(chunk))
        }
      }
      const raw = Buffer.concat(chunks)
      if (upstreamResp.ok && contentType.includes("application/json")) {
        validateSuccessfulJson(req.path, raw)
      }
      res.send(raw)
      return
    }

    // Real-time incremental SSE streaming
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8")
    res.setHeader("Cache-Control", "no-cache")
    res.setHeader("Connection", "keep-alive")
    res.setHeader("X-Accel-Buffering", "no")
    res.flushHeaders?.()

    if (!upstreamResp.body) {
      res.end()
      return
    }

    const reader = upstreamResp.body.getReader()
    const decoder = new TextDecoder()
    let pending = ""
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        resetTimeout()
        if (res.destroyed) break
        pending += decoder.decode(value, { stream: true })
        for (;;) {
          const boundary = /\r?\n\r?\n/.exec(pending)
          if (!boundary) break
          const frame = pending.slice(0, boundary.index)
          const separator = boundary[0]
          pending = pending.slice(boundary.index + separator.length)
          validateSseFrame(frame)
          if (!res.write(frame + separator)) {
            await once(res, "drain", { signal: cancellation.signal })
          }
        }
      }
      pending += decoder.decode()
      if (pending.trim()) throw new Error("Truncated upstream stream")
      if (!res.destroyed) res.end()
    } finally {
      reader.releaseLock()
    }
  } catch (err: unknown) {
    cancellation.abort()
    if (res.destroyed) return
    if (res.headersSent) {
      res.end(
        `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: "Upstream stream interrupted" } })}\n\n`,
      )
      return
    }
    const status = err instanceof Error && err.name === "AbortError" ? 504 : 502
    res.status(status).json({
      type: "error",
      error: {
        type: "api_error",
        message: "Upstream request failed or timed out",
      },
    })
  } finally {
    clearTimeout(timeout)
    cancellation.dispose()
  }
}
