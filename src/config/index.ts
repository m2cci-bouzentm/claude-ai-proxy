import "dotenv/config"
import crypto from "crypto"
import os from "os"
import path from "path"
import { cacheTtlSchema, envConfigSchema, upstreamTimeoutSchema } from "../schemas/config.schema"
import { ProxyError } from "../errors/proxy-error"

const parsedConfig = envConfigSchema.parse({
  apiKey: process.env.API_KEY,
  defaultModel: process.env.DEFAULT_MODEL || "claude-sonnet-4-6",
  port: process.env.PORT || 4181,
  systemPromptPath: process.env.SYSTEM_PROMPT_PATH || path.join(__dirname, "..", "..", "data", "system_prompt.json"),
  accountUuid: process.env.ACCOUNT_UUID || "",
  deviceId: process.env.DEVICE_ID || crypto.randomBytes(32).toString("hex"),
  authDir: process.env.PROXY_AUTH_DIR || process.env.CLAUDE_PROXY_HOME || "/data",
  claudeHome: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
  toolPromptCacheTtl: process.env.TOOL_PROMPT_CACHE_TTL ?? "5m",
  anthropicUpstreamUrl: process.env.ANTHROPIC_UPSTREAM_URL || "https://api.anthropic.com/v1/messages?beta=true",
  toolResponseByteLimit: 8 * 1024 * 1024,
})

export const config = {
  apiKey: parsedConfig.apiKey,
  defaultModel: parsedConfig.defaultModel,
  port: parsedConfig.port,
  systemPromptPath: parsedConfig.systemPromptPath!,
  accountUuid: parsedConfig.accountUuid,
  deviceId: parsedConfig.deviceId!,
  authDir: parsedConfig.authDir,
  claudeHome: parsedConfig.claudeHome!,
  anthropicUpstreamUrl: parsedConfig.anthropicUpstreamUrl,
  toolResponseByteLimit: parsedConfig.toolResponseByteLimit,
} as const

export function getToolCacheTtl() {
  const result = cacheTtlSchema.safeParse(process.env.TOOL_PROMPT_CACHE_TTL ?? "5m")
  if (!result.success) throw new ProxyError("TOOL_PROMPT_CACHE_TTL must be 5m, 1h or off", 500)
  return result.data
}

export function getUpstreamTimeoutMs(): number {
  const result = upstreamTimeoutSchema.safeParse(process.env.ANTHROPIC_TIMEOUT_MS)
  if (!result.success) throw new ProxyError("ANTHROPIC_TIMEOUT_MS must be a positive integer", 500)
  return result.data
}
