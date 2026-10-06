import crypto from "crypto"
import fs from "fs"
import { getAuth } from "../services/auth.service"
import { config } from "../config"
import type { AuthResult } from "../types/auth"
import type { ClaudeMetadata, SystemPromptBlock } from "../types/anthropic"
import type { NativeRequest } from "../types/openai"

const API_URL = "https://api.anthropic.com/v1/messages?beta=true"

import { ANTHROPIC_BETAS as BETAS } from "./anthropic-betas"

// Upstream gates newer models on the Claude Code version it sees in the
// User-Agent and billing header. Keep it at the current installed CLI.
const CLAUDE_CODE_VERSION = "2.1.280"

const SYSTEM_PROMPT: SystemPromptBlock[] = (() => {
  const raw = JSON.parse(fs.readFileSync(config.systemPromptPath, "utf-8"))
  const blocks: SystemPromptBlock[] = Array.isArray(raw) ? raw : [{ type: "text", text: raw }]
  return blocks.map((block) =>
    block.type === "text" && block.text?.startsWith("x-anthropic-billing-header:")
      ? {
          ...block,
          text: block.text.replace(/cc_version=\d+\.\d+\.\d+/, `cc_version=${CLAUDE_CODE_VERSION}`),
        }
      : block,
  )
})()

function buildHeaders(auth: AuthResult): Record<string, string> {
  return {
    Authorization: `Bearer ${auth.accessToken}`,
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": BETAS.join(","),
    "anthropic-dangerous-direct-browser-access": "true",
    "x-app": "cli",
    "x-client-request-id": crypto.randomUUID(),
    "X-Claude-Code-Session-Id": crypto.randomUUID(),
    "X-Stainless-Lang": "js",
    "X-Stainless-Package-Version": "0.94.0",
    "X-Stainless-Runtime": "node",
    "X-Stainless-Runtime-Version": process.versions.node,
    "X-Stainless-Retry-Count": "0",
    "User-Agent": `claude-cli/${CLAUDE_CODE_VERSION} (external, sdk-cli)`,
  }
}

function buildMetadata(): ClaudeMetadata {
  return {
    user_id: JSON.stringify({
      device_id: config.deviceId,
      account_uuid: config.accountUuid,
      session_id: crypto.randomUUID(),
    }),
  }
}

// Tool route transport shares auth and transport identity with Claude Code.
export async function createToolResponse(request: NativeRequest, signal: AbortSignal): Promise<Response> {
  const auth = await getAuth()
  const { system: consumerSystem, ...payload } = request
  const consumerBlocks = Array.isArray(consumerSystem)
    ? consumerSystem
    : consumerSystem
      ? [{ type: "text" as const, text: consumerSystem }]
      : []
  // Keep trusted, version-normalized billing prompt first; append caller
  // system/developer instructions without allowing replacement.
  return fetch(API_URL, {
    method: "POST",
    headers: buildHeaders(auth),
    body: JSON.stringify({
      ...payload,
      system: [...SYSTEM_PROMPT, ...consumerBlocks],
      stream: true,
      metadata: buildMetadata(),
    }),
    signal,
  })
}
