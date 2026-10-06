import { z } from "zod"

export const upstreamUsageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative().nullish(),
    output_tokens: z.number().int().nonnegative().nullish(),
    cache_creation_input_tokens: z.number().int().nonnegative().nullish(),
    cache_read_input_tokens: z.number().int().nonnegative().nullish(),
  })
  .passthrough()
export type UpstreamUsage = z.infer<typeof upstreamUsageSchema>

export const upstreamMessageSchema = z
  .object({
    id: z.string().optional(),
    type: z.string().optional(),
    role: z.string().optional(),
    content: z.array(z.record(z.string(), z.unknown())).optional(),
    model: z.string().optional(),
    stop_reason: z.string().nullable().optional(),
    stop_sequence: z.string().nullable().optional(),
    usage: upstreamUsageSchema.optional(),
  })
  .passthrough()
export type UpstreamMessage = z.infer<typeof upstreamMessageSchema>

export const upstreamEventSchema = z
  .object({
    type: z.string(),
    message: upstreamMessageSchema.optional(),
    index: z.number().optional(),
    content_block: z.record(z.string(), z.unknown()).optional(),
    delta: z.record(z.string(), z.unknown()).optional(),
    usage: upstreamUsageSchema.optional(),
  })
  .passthrough()
export type UpstreamEvent = z.infer<typeof upstreamEventSchema>

export const upstreamModelSchema = z
  .object({
    id: z.string(),
    type: z.string().optional(),
    display_name: z.string().optional(),
    created_at: z.string().optional(),
  })
  .passthrough()

export const upstreamModelsResponseSchema = z
  .object({
    data: z.array(upstreamModelSchema),
    has_more: z.boolean().optional(),
    first_id: z.string().nullable().optional(),
    last_id: z.string().nullable().optional(),
  })
  .passthrough()
export type UpstreamModelsResponse = z.infer<typeof upstreamModelsResponseSchema>

export const upstreamCountTokensResponseSchema = z
  .object({
    input_tokens: z.number().int().nonnegative(),
  })
  .passthrough()
export type UpstreamCountTokensResponse = z.infer<typeof upstreamCountTokensResponseSchema>
