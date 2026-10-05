import * as openAIService from "../services/openai.service";
import crypto from "crypto";
import { createRequestCancellation } from "../utils/abort";
import { sendToolError } from "../utils/tool-error";
import type {
    ToolTransport,
    ToolRequestHandler,
    ToolStreamDelta,
    FinishReason,
} from "../types/tool";

export type OpenAIRequestHandler = ToolRequestHandler;

export function createOpenAIController(
    transport: ToolTransport,
    defaultModel: string,
): OpenAIRequestHandler {
    return async (req, res) => {
        const cancellation = createRequestCancellation(res);
        const liveText = req.body.stream === true && req.body.tools.length === 0;
        const liveBase = { id: `chatcmpl-${crypto.randomUUID()}`, created: Math.floor(Date.now()/1000), model: req.body.model ?? defaultModel, object: "chat.completion.chunk" };
        let liveStarted = false;
        const onText = (content: string) => {
            if (res.destroyed) { cancellation.abort(); return; }
            if (!liveStarted) {
                res.setHeader("Content-Type", "text/event-stream");
                res.setHeader("Cache-Control", "no-cache");
                res.setHeader("X-Accel-Buffering", "no");
                res.write(`data: ${JSON.stringify({...liveBase, choices:[{index:0,delta:{role:"assistant",content:""},finish_reason:null}]})}\n\n`);
                liveStarted = true;
            }
            res.write(`data: ${JSON.stringify({...liveBase, choices:[{index:0,delta:{content},finish_reason:null}]})}\n\n`);
        };
        try {
            const { result, stream, includeUsage } =
                await openAIService.completeOpenAIChat(
                    req.body,
                    defaultModel,
                    transport,
                    cancellation.signal,
                    liveText ? onText : undefined,
                );
            if (res.destroyed) return;
            if (!stream) {
                res.json(result);
                return;
            }
            // Buffer tool turns until all calls validate; never expose executable partial calls.
            if (!liveStarted) {
                res.setHeader("Content-Type", "text/event-stream");
                res.setHeader("Cache-Control", "no-cache");
                res.setHeader("X-Accel-Buffering", "no");
            }
            const { id, created, model, choices, usage } = result;
            const base = {
                id: liveStarted ? liveBase.id : id,
                created: liveStarted ? liveBase.created : created,
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
            if (!liveStarted) emit({ role: "assistant", content: "" });
            if (choices[0].message.refusal)
                emit({
                    refusal: choices[0].message.refusal,
                    refusal_details: choices[0].message.refusal_details,
                });
            if (choices[0].message.reasoning_details)
                emit({
                    reasoning_details: choices[0].message.reasoning_details,
                });
            if (choices[0].message.content && !liveStarted)
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

export const createToolController = createOpenAIController;
