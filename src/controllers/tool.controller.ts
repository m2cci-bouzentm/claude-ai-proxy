import * as toolService from "../services/tool.service";
import { createRequestCancellation } from "../utils/abort";
import { sendToolError } from "../utils/tool-error";
import type {
    ToolTransport,
    ToolRequestHandler,
    ToolStreamDelta,
    FinishReason,
} from "../types/tool";

export function createToolController(
    transport: ToolTransport,
    defaultModel: string,
): ToolRequestHandler {
    return async (req, res) => {
        const cancellation = createRequestCancellation(res);
        try {
            const { result, stream, includeUsage } =
                await toolService.completeToolChat(
                    req.body,
                    defaultModel,
                    transport,
                    cancellation.signal,
                );
            if (res.destroyed) return;
            if (!stream) {
                res.json(result);
                return;
            }
            // Buffer tool turns until all calls validate; never expose executable partial calls.
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("X-Accel-Buffering", "no");
            const { id, created, model, choices, usage } = result;
            const base = {
                id,
                created,
                model,
                object: "chat.completion.chunk",
            };
            const emit = (
                delta: ToolStreamDelta,
                finish: FinishReason | null = null,
            ) =>
                res.write(
                    `data: ${JSON.stringify({
                        ...base,
                        choices: [{ index: 0, delta, finish_reason: finish }],
                        ...(includeUsage ? { usage: null } : {}),
                    })}\n\n`,
                );
            emit({ role: "assistant", content: "" });
            if (choices[0].message.refusal)
                emit({
                    refusal: choices[0].message.refusal,
                    refusal_details: choices[0].message.refusal_details,
                });
            if (choices[0].message.reasoning_details)
                emit({
                    reasoning_details: choices[0].message.reasoning_details,
                });
            if (choices[0].message.content)
                emit({ content: choices[0].message.content });
            choices[0].message.tool_calls?.forEach((call, index) =>
                emit({ tool_calls: [{ index, ...call }] }),
            );
            emit({}, choices[0].finish_reason);
            if (includeUsage)
                res.write(
                    `data: ${JSON.stringify({ ...base, choices: [], usage })}\n\n`,
                );
            res.end("data: [DONE]\n\n");
        } catch (err) {
            cancellation.abort();
            sendToolError(res, err);
        } finally {
            cancellation.dispose();
        }
    };
}
