import crypto from "crypto";
import { Stream } from "@anthropic-ai/sdk/core/streaming";
import { MessageStream } from "@anthropic-ai/sdk/lib/MessageStream";
import type { MessageStreamEvent } from "@anthropic-ai/sdk/resources/messages";
import type { RequestHandler } from "express";
import Ajv, { type ValidateFunction } from "ajv";

type Obj = Record<string, any>;
type Transport = (body: Record<string, unknown>, signal: AbortSignal) => Promise<Response>;
class ToolError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
function record(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, nullable = false): string {
  if (nullable && value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every(p => record(p) && p.type === "text" && typeof p.text === "string")) {
    return value.map(p => p.text).join("\n");
  }
  throw new ToolError("Only text message content is supported on this endpoint");
}
function localReferences(value: unknown): void {
  if (Array.isArray(value)) value.forEach(localReferences);
  else if (record(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (["$ref", "$dynamicRef"].includes(key) && (typeof item !== "string" || !item.startsWith("#"))) {
        throw new ToolError("Only local JSON schema references are supported");
      }
      localReferences(item);
    }
  }
}

export function prepareToolRequest(input: unknown, defaultModel: string) {
  if (!record(input) || !Array.isArray(input.messages) || input.messages.length === 0) {
    throw new ToolError("messages must be a nonempty array");
  }
  const model = input.model ?? defaultModel;
  const maxTokens = input.max_completion_tokens ?? input.max_tokens ?? 8192;
  if (typeof model !== "string" || !model || !Number.isInteger(maxTokens) || maxTokens < 1) {
    throw new ToolError("model and max_tokens must be valid");
  }
  for (const name of ["stream", "parallel_tool_calls"]) {
    if (input[name] !== undefined && typeof input[name] !== "boolean") throw new ToolError(`${name} must be boolean`);
  }
  if (input.n !== undefined && input.n !== 1) throw new ToolError("Only n=1 is supported");
  if (input.response_format !== undefined || input.functions !== undefined || input.function_call !== undefined) {
    throw new ToolError("Use tools/tool_choice; response_format and legacy functions are unsupported");
  }
  if (input.stream_options !== undefined && (!record(input.stream_options) ||
      (input.stream_options.include_usage !== undefined && typeof input.stream_options.include_usage !== "boolean"))) {
    throw new ToolError("Invalid stream_options");
  }
  const definitions = input.tools ?? [];
  if (!Array.isArray(definitions) || definitions.length > 128) throw new ToolError("tools must contain at most 128 functions");
  const registry = new Map<string, ValidateFunction>();
  const tools = definitions.map((tool: unknown) => {
    if (!record(tool) || tool.type !== "function" || !record(tool.function)) throw new ToolError("Only function tools are supported");
    const fn = tool.function;
    if (typeof fn.name !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(fn.name) || registry.has(fn.name)) {
      throw new ToolError("Tool names must be unique and contain 1–64 letters, digits, underscores or hyphens");
    }
    const schema = fn.parameters ?? { type: "object", properties: {} };
    if (!record(schema) || schema.type !== "object") throw new ToolError("Tool parameters must be an object JSON schema");
    localReferences(schema);
    try {
      // Separate compiler per tool prevents duplicate $id conflicts across tools.
      // No coercion, defaults, removal of properties, or remote schema loading.
      registry.set(fn.name, new Ajv({ strict: false, validateFormats: false }).compile(schema));
    } catch { throw new ToolError("Invalid or unsupported tool parameter schema (use JSON Schema draft-07)"); }
    if (fn.description !== undefined && typeof fn.description !== "string") throw new ToolError("Invalid tool description");
    return { name: fn.name, ...(fn.description !== undefined ? { description: fn.description } : {}), input_schema: schema };
  });
  const choice = input.tool_choice ?? (tools.length ? "auto" : "none");
  let mode: string, forced: string | undefined;
  if (record(choice) && choice.type === "function" && record(choice.function) && registry.has(choice.function.name)) {
    mode = "required"; forced = choice.function.name;
  } else if (typeof choice === "string" && ["none", "auto", "required"].includes(choice)) mode = choice;
  else throw new ToolError("tool_choice must be none, auto, required or a supplied function name");
  if (mode === "required" && !tools.length) throw new ToolError("tool_choice requires tools");
  const system: string[] = [], messages: Obj[] = [];
  const pending = new Set<string>(), seen = new Set<string>();
  for (const message of input.messages) {
    if (!record(message)) throw new ToolError("Invalid message");
    const role = message.role;
    if (!["system", "developer", "user", "assistant", "tool"].includes(role)) throw new ToolError("Invalid message role");
    const content = text(message.content, role === "assistant");
    if (role === "system" || role === "developer") { system.push(content); continue; }
    let blocks: Obj[] = [];
    if (role === "tool") {
      if (typeof message.tool_call_id !== "string" || !pending.delete(message.tool_call_id)) {
        throw new ToolError("Tool result must match an outstanding tool_call_id");
      }
      blocks.push({ type: "tool_result", tool_use_id: message.tool_call_id, content });
    } else {
      if (pending.size) throw new ToolError("Supply all tool results before continuing the conversation");
      if (content) blocks.push({ type: "text", text: content });
      if (message.tool_calls !== undefined) {
        if (role !== "assistant" || !Array.isArray(message.tool_calls)) throw new ToolError("Invalid tool_calls history");
        for (const call of message.tool_calls) {
          if (!record(call) || call.type !== "function" || typeof call.id !== "string" || !call.id || seen.has(call.id) ||
              !record(call.function) || typeof call.function.name !== "string" || typeof call.function.arguments !== "string") {
            throw new ToolError("Invalid or duplicate historical tool call");
          }
          let args: unknown;
          try { args = JSON.parse(call.function.arguments); } catch { throw new ToolError("Invalid historical tool arguments"); }
          if (!record(args)) throw new ToolError("Tool arguments must be JSON objects");
          seen.add(call.id); pending.add(call.id);
          blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input: args });
        }
      }
    }
    if (!blocks.length) throw new ToolError("Empty message");
    const nativeRole = role === "assistant" ? "assistant" : "user";
    // Consecutive results must occupy one user turn, preserving every call ID.
    if (messages.at(-1)?.role === nativeRole) messages.at(-1)!.content.push(...blocks);
    else messages.push({ role: nativeRole, content: blocks });
  }
  if (pending.size) throw new ToolError("Missing tool results");
  if (!messages.length || messages[0].role !== "user" || messages.at(-1)!.role !== "user") {
    throw new ToolError("Conversation must start and end with a user message or tool result");
  }
  const request: Obj = { model, max_tokens: maxTokens, messages };
  if (system.length) request.system = system.join("\n\n");
  // Some subscriber-tier backends emit an empty turn for tools + choice=none.
  // Omitting the definitions disables calls without relying on that path.
  if (tools.length && mode !== "none") {
    request.tools = tools;
    request.tool_choice = {
      type: forced ? "tool" : mode === "required" ? "any" : "auto",
      ...(forced ? { name: forced } : {}),
      ...(input.parallel_tool_calls === false ? { disable_parallel_tool_use: true } : {}),
    };
  }
  // Do not enable adaptive thinking here: forced tools are incompatible with it.
  for (const key of ["temperature", "top_p"]) {
    if (input[key] !== undefined) {
      const max = 1;
      if (typeof input[key] !== "number" || !Number.isFinite(input[key]) || input[key] < 0 || input[key] > max) throw new ToolError(`Invalid ${key}`);
      request[key] = input[key];
    }
  }
  if (input.stop !== undefined) {
    const stop = typeof input.stop === "string" ? [input.stop] : input.stop;
    if (!Array.isArray(stop) || !stop.every(s => typeof s === "string" && s.length)) throw new ToolError("Invalid stop sequences");
    request.stop_sequences = stop;
  }
  return { request, registry, mode, forced, parallel: input.parallel_tool_calls !== false,
    stream: input.stream === true, includeUsage: input.stream_options?.include_usage === true };
}

export async function collectToolResponse(response: Response, prepared: ReturnType<typeof prepareToolRequest>) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new ToolError(`Claude API request failed (${response.status})`, response.status === 429 ? 429 : 502);
  }
  if (!response.body) throw new ToolError("Empty upstream response", 502);
  // Reuse the official SDK for SSE framing, UTF-8 decoding, error events,
  // incremental JSON and message assembly instead of maintaining a parser.
  let bytes = 0, stopped = false;
  const bounded = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > 8 * 1024 * 1024) throw new ToolError("Upstream response exceeds 8 MiB", 502);
      controller.enqueue(chunk);
    },
  }));
  const sse = Stream.fromSSEResponse<MessageStreamEvent>(new Response(bounded, { headers: response.headers }), new AbortController());
  const stream = MessageStream.fromReadableStream(sse.toReadableStream());
  const openBlocks = new Set<number>(), rawArguments = new Map<number, string>();
  stream.on("streamEvent", e => {
    if (e.type === "message_stop") stopped = true;
    if (e.type === "content_block_start") openBlocks.add(e.index);
    if (e.type === "content_block_stop") openBlocks.delete(e.index);
    if (e.type === "content_block_delta" && e.delta.type === "input_json_delta") {
      rawArguments.set(e.index, (rawArguments.get(e.index) ?? "") + e.delta.partial_json);
    }
  });
  const message = await stream.finalMessage();
  if (!stopped || openBlocks.size) throw new ToolError("Incomplete upstream stream", 502);
  // SDK incrementally parses partial JSON; only complete, strict JSON is
  // executable. Reject an unterminated argument object even if SDK recovered it.
  for (const raw of rawArguments.values()) {
    try { JSON.parse(raw); } catch { throw new ToolError("Invalid upstream tool arguments", 502); }
  }
  const finish = message.stop_reason;
  const prompt = message.usage.input_tokens + (message.usage.cache_read_input_tokens ?? 0) + (message.usage.cache_creation_input_tokens ?? 0);
  const completion = message.usage.output_tokens;
  const calls: Obj[] = [], ids = new Set<string>();
  let content = "";
  for (const b of message.content) {
    if (b.type === "text") content += b.text ?? "";
    if (b.type !== "tool_use") continue;
    const validate = prepared.registry.get(b.name);
    if (!validate || prepared.mode === "none" || (prepared.forced && b.name !== prepared.forced) ||
        typeof b.id !== "string" || !b.id || ids.has(b.id)) throw new ToolError("Upstream returned a disallowed tool call", 502);
    const args = b.input;
    if (!record(args) || !validate(args)) throw new ToolError("Upstream tool arguments failed schema validation", 502);
    ids.add(b.id);
    calls.push({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(args) } });
  }
  if ((!prepared.parallel && calls.length > 1) || (prepared.mode === "required" && !calls.length)) throw new ToolError("Upstream violated tool_choice", 502);
  if (!calls.length && !content && finish === "end_turn") throw new ToolError("Upstream returned an empty turn", 502);
  if (calls.length && finish !== "tool_use") throw new ToolError("Upstream tool turn was incomplete", 502);
  if (!calls.length && !["end_turn", "stop_sequence", "max_tokens", "refusal"].includes(finish ?? "")) throw new ToolError("Unsupported upstream stop reason", 502);
  return { id: `chatcmpl-${crypto.randomUUID()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000),
    model: prepared.request.model, choices: [{ index: 0, message: { role: "assistant", content: content || null,
      ...(calls.length ? { tool_calls: calls } : {}) },
      finish_reason: calls.length ? "tool_calls" : finish === "max_tokens" ? "length" : finish === "refusal" ? "content_filter" : "stop" }],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion } };
}

export function createToolHandler(transport: Transport, defaultModel: string): RequestHandler {
  return async (req, res) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.on("close", disconnect);
    try {
      const prepared = prepareToolRequest(req.body, defaultModel);
      const result = await collectToolResponse(await transport(prepared.request, controller.signal), prepared);
      if (res.destroyed) return;
      if (!prepared.stream) { res.json(result); return; }
      // Buffer tool turns until all calls validate; never expose executable partial calls.
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("X-Accel-Buffering", "no");
      const { id, created, model, choices, usage } = result;
      const base = { id, created, model, object: "chat.completion.chunk" };
      const emit = (delta: Obj, finish: string | null = null) => res.write(`data: ${JSON.stringify({ ...base,
        choices: [{ index: 0, delta, finish_reason: finish }], ...(prepared.includeUsage ? { usage: null } : {}) })}\n\n`);
      emit({ role: "assistant", content: "" });
      if (choices[0].message.content) emit({ content: choices[0].message.content });
      choices[0].message.tool_calls?.forEach((call: Obj, index: number) => emit({ tool_calls: [{ index, ...call }] }));
      emit({}, choices[0].finish_reason);
      if (prepared.includeUsage) res.write(`data: ${JSON.stringify({ ...base, choices: [], usage })}\n\n`);
      res.end("data: [DONE]\n\n");
    } catch (err) {
      controller.abort();
      if (!res.destroyed) {
        const status = err instanceof ToolError ? err.status : (err as Error).name === "AbortError" ? 504 : 502;
        const message = err instanceof ToolError ? err.message : "Tool request failed or timed out";
        res.status(status).json({ error: { message, type: status < 500 ? "invalid_request_error" : "upstream_error" } });
      }
    } finally { clearTimeout(timeout); res.off("close", disconnect); }
  };
}
