import { z } from "zod";

export const anthropicMessageParamSchema = z.object({
    role: z.enum(["user", "assistant"]),
    content: z.union([
        z.string(),
        z.array(z.record(z.string(), z.unknown())),
    ]),
}).passthrough();
export type AnthropicMessageParam = z.infer<typeof anthropicMessageParamSchema>;

export const anthropicMessagesRequestSchema = z.object({
    messages: z.array(anthropicMessageParamSchema).min(1),
    model: z.string().min(1).optional(),
    max_tokens: z.number().int().positive().optional(),
    stream: z.boolean().optional(),
    system: z.union([
        z.string(),
        z.array(z.record(z.string(), z.unknown())),
    ]).optional(),
    tools: z.array(z.record(z.string(), z.unknown())).optional(),
    tool_choice: z.record(z.string(), z.unknown()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    stop_sequences: z.array(z.string()).optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    top_k: z.number().optional(),
    thinking: z.record(z.string(), z.unknown()).optional(),
}).passthrough();
export type AnthropicMessagesRequest = z.infer<typeof anthropicMessagesRequestSchema>;

export const anthropicCountTokensRequestSchema = z.object({
    messages: z.array(anthropicMessageParamSchema).min(1),
    model: z.string().min(1).optional(),
    system: z.union([
        z.string(),
        z.array(z.record(z.string(), z.unknown())),
    ]).optional(),
    tools: z.array(z.record(z.string(), z.unknown())).optional(),
    tool_choice: z.record(z.string(), z.unknown()).optional(),
    thinking: z.record(z.string(), z.unknown()).optional(),
}).passthrough();
export type AnthropicCountTokensRequest = z.infer<typeof anthropicCountTokensRequestSchema>;

export const anthropicModelsQuerySchema = z.object({
    before_id: z.string().optional(),
    after_id: z.string().optional(),
    limit: z.coerce.number().int().positive().optional(),
}).passthrough();
export type AnthropicModelsQuery = z.infer<typeof anthropicModelsQuerySchema>;
