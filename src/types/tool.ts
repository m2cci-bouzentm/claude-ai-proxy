import type { z } from "zod";
import type { RequestHandler } from "express";
import type { ParamsDictionary } from "express-serve-static-core";
import type { ValidateFunction } from "ajv";
import type {
    ContentBlockParam,
    MessageCreateParamsNonStreaming,
    ThinkingBlock,
    RedactedThinkingBlock,
} from "@anthropic-ai/sdk/resources/messages";
import type { toolRequestSchema } from "../schemas/tool.schema";

export type ToolRequest = z.output<typeof toolRequestSchema>;
export type ToolRequestHandler = RequestHandler<
    ParamsDictionary,
    unknown,
    ToolRequest
>;
export type NativeRequest = MessageCreateParamsNonStreaming;
export type ToolTransport = (
    body: NativeRequest,
    signal: AbortSignal,
) => Promise<Response>;
export type NativeMessage = {
    role: "user" | "assistant";
    content: ContentBlockParam[];
};
export type ConsumerInstructions = { source_role: string; content: string };
export type ToolCall = {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
};
export type ToolMode = "auto" | "none" | "required";
export type FinishReason = "tool_calls" | "length" | "content_filter" | "stop";

export interface PreparedToolRequest {
    request: NativeRequest;
    registry: Map<string, ValidateFunction>;
    mode: ToolMode;
    forced?: string;
    parallel: boolean;
    stream: boolean;
    includeUsage: boolean;
}

export interface ToolMessage {
    role: "assistant";
    content: string | null;
    reasoning_details?: Array<ThinkingBlock | RedactedThinkingBlock>;
    tool_calls?: ToolCall[];
}

export interface ToolCompletion {
    id: string;
    object: "chat.completion";
    created: number;
    model: string;
    choices: Array<{
        index: number;
        message: ToolMessage;
        finish_reason: FinishReason;
    }>;
    usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        prompt_tokens_details: {
            cached_tokens: number;
            cache_write_tokens: number;
        };
    };
}

export type ToolStreamDelta = Omit<Partial<ToolMessage>, "tool_calls"> & {
    tool_calls?: Array<ToolCall & { index: number }>;
};
