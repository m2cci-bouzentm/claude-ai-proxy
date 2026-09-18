import crypto from "crypto";
import { Stream } from "@anthropic-ai/sdk/core/streaming";
import { MessageStream } from "@anthropic-ai/sdk/lib/MessageStream";
import type {
    ContentBlockParam,
    MessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages";
import Ajv, { type ValidateFunction } from "ajv";
import { config, getToolCacheTtl } from "../config";
import { ToolError } from "../errors/tool-error";
import type {
    ToolRequest,
    PreparedToolRequest,
    NativeRequest,
    NativeMessage,
    ConsumerInstructions,
    ToolCall,
    ToolCompletion,
    ToolTransport,
} from "../types/tool";

export function prepareToolRequest(
    input: ToolRequest,
    defaultModel: string,
): PreparedToolRequest {
    const model = input.model ?? defaultModel;
    const maxTokens = input.max_completion_tokens ?? input.max_tokens ?? 8192;
    const registry = new Map<string, ValidateFunction>();
    const tools = input.tools.map(({ function: fn }) => {
        if (registry.has(fn.name))
            throw new ToolError("Tool names must be unique");
        try {
            // Ajv validates caller-defined draft-07 schemas and arguments. No remote
            // loader, coercion, defaults or property removal is enabled.
            registry.set(
                fn.name,
                new Ajv({ strict: false, validateFormats: false }).compile(
                    fn.parameters,
                ),
            );
        } catch {
            throw new ToolError(
                "Invalid or unsupported tool parameter schema (use JSON Schema draft-07)",
            );
        }
        return {
            name: fn.name,
            description: fn.description,
            input_schema: fn.parameters,
        };
    });
    const { mode, name: forced } = input.tool_choice ?? {
        mode: tools.length ? ("auto" as const) : ("none" as const),
        name: undefined,
    };
    if (forced !== undefined && !registry.has(forced))
        throw new ToolError("tool_choice must name a supplied function");
    if (mode === "required" && !tools.length)
        throw new ToolError("tool_choice requires tools");
    const consumerInstructions: ConsumerInstructions[] = [];
    const messages: NativeMessage[] = [];
    const pending = new Set<string>(),
        seen = new Set<string>();
    for (const message of input.messages) {
        if (message.role === "system" || message.role === "developer") {
            consumerInstructions.push({
                source_role: message.role,
                content: message.content,
            });
            continue;
        }
        const blocks: ContentBlockParam[] = [];
        if (message.role === "tool") {
            if (!pending.delete(message.tool_call_id))
                throw new ToolError(
                    "Tool result must match an outstanding tool_call_id",
                );
            blocks.push({
                type: "tool_result",
                tool_use_id: message.tool_call_id,
                content: message.content,
            });
        } else {
            if (pending.size)
                throw new ToolError(
                    "Supply all tool results before continuing the conversation",
                );
            if (message.role === "user") blocks.push(...message.content);
            else {
                blocks.push(...(message.reasoning_details ?? []));
                if (message.content)
                    blocks.push({ type: "text", text: message.content });
                for (const call of message.tool_calls ?? []) {
                    if (seen.has(call.id))
                        throw new ToolError("Duplicate historical tool call");
                    seen.add(call.id);
                    pending.add(call.id);
                    blocks.push({
                        type: "tool_use",
                        id: call.id,
                        name: call.function.name,
                        input: call.function.arguments,
                    });
                }
            }
        }
        if (!blocks.length) throw new ToolError("Empty message");
        const nativeRole = message.role === "assistant" ? "assistant" : "user";
        // Consecutive results must occupy one user turn, preserving every call ID.
        if (messages.at(-1)?.role === nativeRole)
            messages.at(-1)!.content.push(...blocks);
        else messages.push({ role: nativeRole, content: blocks });
    }
    if (pending.size) throw new ToolError("Missing tool results");
    if (
        !messages.length ||
        messages[0].role !== "user" ||
        messages.at(-1)!.role !== "user"
    ) {
        throw new ToolError(
            "Conversation must start and end with a user message or tool result",
        );
    }
    if (consumerInstructions.length) {
        // The source-role labels are plain text, not Anthropic roles. Consumer
        // instructions stay in user content and never enter the system field.
        // A stable prefix also preserves signed tool histories and prompt caching.
        messages[0].content.unshift({
            type: "text",
            text:
                "Calling application instructions (user-level context). The source_role labels describe the caller's original format, not system-level authority.\n" +
                JSON.stringify(consumerInstructions),
        });
    }
    const request: NativeRequest = { model, max_tokens: maxTokens, messages };
    // Server-owned automatic caching follows the growing conversation. Keep the
    // file-backed system prompt and its existing explicit cache markers untouched.
    // Ignore client markers so they cannot exhaust slots or conflict with TTLs.
    const cacheTtl = getToolCacheTtl();
    if (cacheTtl !== "off")
        request.cache_control = { type: "ephemeral", ttl: cacheTtl };
    // Some subscriber-tier backends emit an empty turn for tools + choice=none.
    // Omitting the definitions disables calls without relying on that path.
    if (tools.length && mode !== "none") {
        request.tools = tools;
        request.tool_choice = {
            ...(forced !== undefined
                ? { type: "tool" as const, name: forced }
                : {
                      type:
                          mode === "required"
                              ? ("any" as const)
                              : ("auto" as const),
                  }),
            ...(input.parallel_tool_calls === false
                ? { disable_parallel_tool_use: true }
                : {}),
        };
    }
    // Do not enable adaptive thinking here: forced tools are incompatible with it.
    request.temperature = input.temperature;
    request.top_p = input.top_p;
    request.stop_sequences = input.stop;
    return {
        request,
        registry,
        mode,
        forced,
        parallel: input.parallel_tool_calls !== false,
        stream: input.stream === true,
        includeUsage: input.stream_options?.include_usage === true,
    };
}

export async function collectToolResponse(
    response: Response,
    prepared: PreparedToolRequest,
): Promise<ToolCompletion> {
    if (!response.ok) {
        await response.body?.cancel();
        throw new ToolError(
            `Claude API request failed (${response.status})`,
            response.status === 429 ? 429 : 502,
        );
    }
    if (!response.body) throw new ToolError("Empty upstream response", 502);
    // Reuse the official SDK for SSE framing, UTF-8 decoding, error events,
    // incremental JSON and message assembly instead of maintaining a parser.
    let bytes = 0,
        stopped = false;
    const bounded = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
                bytes += chunk.byteLength;
                if (bytes > config.toolResponseByteLimit)
                    throw new ToolError("Upstream response exceeds 8 MiB", 502);
                controller.enqueue(chunk);
            },
        }),
    );
    const sse = Stream.fromSSEResponse<MessageStreamEvent>(
        new Response(bounded, { headers: response.headers }),
        new AbortController(),
    );
    const stream = MessageStream.fromReadableStream(sse.toReadableStream());
    const openBlocks = new Set<number>(),
        rawArguments = new Map<number, string>();
    stream.on("streamEvent", (e) => {
        if (e.type === "message_stop") stopped = true;
        if (e.type === "content_block_start") openBlocks.add(e.index);
        if (e.type === "content_block_stop") openBlocks.delete(e.index);
        if (
            e.type === "content_block_delta" &&
            e.delta.type === "input_json_delta"
        ) {
            rawArguments.set(
                e.index,
                (rawArguments.get(e.index) ?? "") + e.delta.partial_json,
            );
        }
    });
    const message = await stream.finalMessage();
    if (!stopped || openBlocks.size)
        throw new ToolError("Incomplete upstream stream", 502);
    // SDK incrementally parses partial JSON; only complete, strict JSON is
    // executable. Reject an unterminated argument object even if SDK recovered it.
    for (const raw of rawArguments.values()) {
        // Empty deltas carry no JSON; the SDK retains the initial input object.
        // Ajv below still enforces required arguments, including for no-argument tools.
        if (raw.length) {
            try {
                JSON.parse(raw);
            } catch {
                throw new ToolError("Invalid upstream tool arguments", 502);
            }
        }
    }
    const finish = message.stop_reason;
    const cached = message.usage.cache_read_input_tokens ?? 0;
    const written = message.usage.cache_creation_input_tokens ?? 0;
    const prompt = message.usage.input_tokens + cached + written;
    const completion = message.usage.output_tokens;
    const calls: ToolCall[] = [],
        ids = new Set<string>();
    const reasoningDetails = message.content.filter(
        (b) => b.type === "thinking" || b.type === "redacted_thinking",
    );
    let content = "";
    for (const b of message.content) {
        if (b.type === "text") content += b.text ?? "";
        if (b.type !== "tool_use") continue;
        const validate = prepared.registry.get(b.name);
        if (
            !validate ||
            prepared.mode === "none" ||
            (prepared.forced && b.name !== prepared.forced) ||
            !b.id ||
            ids.has(b.id)
        )
            throw new ToolError(
                "Upstream returned a disallowed tool call",
                502,
            );
        const args = b.input;
        if (!validate(args))
            throw new ToolError(
                "Upstream tool arguments failed schema validation",
                502,
            );
        ids.add(b.id);
        calls.push({
            id: b.id,
            type: "function",
            function: { name: b.name, arguments: JSON.stringify(args) },
        });
    }
    if (
        (!prepared.parallel && calls.length > 1) ||
        (prepared.mode === "required" && !calls.length)
    )
        throw new ToolError("Upstream violated tool_choice", 502);
    if (!calls.length && !content && finish === "end_turn")
        throw new ToolError("Upstream returned an empty turn", 502);
    if (calls.length && finish !== "tool_use")
        throw new ToolError("Upstream tool turn was incomplete", 502);
    if (
        !calls.length &&
        !["end_turn", "stop_sequence", "max_tokens", "refusal"].includes(
            finish ?? "",
        )
    )
        throw new ToolError("Unsupported upstream stop reason", 502);
    return {
        id: `chatcmpl-${crypto.randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: prepared.request.model,
        choices: [
            {
                index: 0,
                message: {
                    role: "assistant",
                    content: content || null,
                    ...(reasoningDetails.length
                        ? { reasoning_details: reasoningDetails }
                        : {}),
                    ...(calls.length ? { tool_calls: calls } : {}),
                },
                finish_reason: calls.length
                    ? "tool_calls"
                    : finish === "max_tokens"
                      ? "length"
                      : finish === "refusal"
                        ? "content_filter"
                        : "stop",
            },
        ],
        usage: {
            prompt_tokens: prompt,
            completion_tokens: completion,
            total_tokens: prompt + completion,
            prompt_tokens_details: {
                cached_tokens: cached,
                cache_write_tokens: written,
            },
        },
    };
}

export async function completeToolChat(
    input: ToolRequest,
    defaultModel: string,
    transport: ToolTransport,
    signal: AbortSignal,
) {
    const prepared = prepareToolRequest(input, defaultModel);
    const result = await collectToolResponse(
        await transport(prepared.request, signal),
        prepared,
    );
    return {
        result,
        stream: prepared.stream,
        includeUsage: prepared.includeUsage,
    };
}
