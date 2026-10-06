import { z } from "zod"

export const cacheTtlSchema = z.enum(["5m", "1h", "off"])

export const envConfigSchema = z.object({
  apiKey: z.string().optional(),
  defaultModel: z.string().min(1).default("claude-sonnet-4-6"),
  port: z.coerce.number().int().nonnegative().default(4181),
  systemPromptPath: z.string().min(1).optional(),
  accountUuid: z.string().default(""),
  deviceId: z.string().min(1).optional(),
  authDir: z.string().min(1).default("/data"),
  claudeHome: z.string().min(1).optional(),
  toolPromptCacheTtl: cacheTtlSchema.default("5m"),
  anthropicUpstreamUrl: z.string().url().default("https://api.anthropic.com/v1/messages?beta=true"),
  anthropicTimeoutMs: z.coerce.number().int().positive().default(120_000),
  toolRequestTimeoutMs: z.coerce.number().int().positive().default(120_000),
  toolResponseByteLimit: z.coerce
    .number()
    .int()
    .positive()
    .default(8 * 1024 * 1024),
})
export type EnvConfig = z.infer<typeof envConfigSchema>
