import type { Response } from "express";
import {
    createCompletion,
    createStreamingResponse,
} from "../lib/claude-client";
import { config } from "../config";
import type { LegacyMessage, LegacyChatHandler } from "../types/chat";

function toOpenAIChunk(
    model: string,
    content: string | null,
    finish: string | null,
) {
    return JSON.stringify({
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
            {
                index: 0,
                delta: content !== null ? { content } : {},
                finish_reason: finish,
            },
        ],
    });
}

async function handleStream(
    res: Response,
    messages: LegacyMessage[],
    model: string,
    maxTokens: number,
) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    try {
        const streamResp = await createStreamingResponse(
            messages,
            model,
            maxTokens,
        );
        const reader = streamResp.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
                if (!line.startsWith("data: ")) continue;
                try {
                    const evt = JSON.parse(line.slice(6).trim());
                    if (
                        evt.type === "content_block_delta" &&
                        evt.delta?.type === "text_delta"
                    ) {
                        res.write(
                            `data: ${toOpenAIChunk(model, evt.delta.text, null)}\n\n`,
                        );
                    }
                    if (evt.type === "message_stop") {
                        res.write(
                            `data: ${toOpenAIChunk(model, null, "stop")}\n\n`,
                        );
                        res.write("data: [DONE]\n\n");
                    }
                } catch {}
            }
        }
    } catch (err) {
        res.write(
            `data: ${JSON.stringify({ error: { message: (err as Error).message } })}\n\n`,
        );
    }
    res.end();
}

export const handleCompletion: LegacyChatHandler = async (req, res) => {
    const { messages, model, max_tokens, max_completion_tokens, stream } =
        req.body;

    if (!messages || !messages.length) {
        res.status(400).json({
            error: { message: "messages is required", type: "invalid_request" },
        });
        return;
    }

    const selectedModel = model || config.defaultModel;
    const maxTokens = max_tokens || max_completion_tokens || 8192;

    if (stream) return handleStream(res, messages, selectedModel, maxTokens);

    try {
        const { content, usage } = await createCompletion(
            messages,
            selectedModel,
            maxTokens,
        );
        res.json({
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: selectedModel,
            choices: [
                {
                    index: 0,
                    message: { role: "assistant", content },
                    finish_reason: "stop",
                },
            ],
            usage: {
                prompt_tokens: usage.input_tokens,
                completion_tokens: usage.output_tokens,
                total_tokens: usage.input_tokens + usage.output_tokens,
            },
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        console.error("request failed:", message);
        res.status(500).json({ error: { message, type: "server_error" } });
    }
};
