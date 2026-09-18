import type { RequestHandler } from "express";
import type { ParamsDictionary } from "express-serve-static-core";

export interface LegacyMessage {
    role: string;
    content: string | Array<{ type: string; text?: string }>;
}

export interface LegacyCompletion {
    content: string;
    usage: { input_tokens: number; output_tokens: number };
}

export interface LegacyChatBody {
    messages?: LegacyMessage[];
    model?: string;
    max_tokens?: number;
    max_completion_tokens?: number;
    stream?: boolean;
}

export type LegacyChatHandler = RequestHandler<
    ParamsDictionary,
    unknown,
    LegacyChatBody
>;

export interface ClaudeMetadata {
    user_id: string;
}

export interface SystemPromptBlock {
    type: string;
    text?: string;
}
