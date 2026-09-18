import { z } from "zod";
import type { ImageBlockParam } from "@anthropic-ai/sdk/resources/messages";

export class ToolError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

// Use the SDK's native image source representation; never download caller URLs.
function imageBlock(value: { url: string }): ImageBlockParam {
  const url = value.url;
  if (url.startsWith("data:")) {
    const match = /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
    if (!match || match[2].length % 4 !== 0) throw new ToolError("Use a base64 JPEG, PNG, GIF or WebP image data URL");
    const bytes = Buffer.from(match[2], "base64");
    if (!bytes.length || bytes.toString("base64") !== match[2]) throw new ToolError("Invalid image base64");
    if (bytes.length > 5 * 1024 * 1024) throw new ToolError("Image exceeds the 5 MiB limit", 413);
    return { type: "image", source: { type: "base64", media_type: match[1] as "image/png" | "image/jpeg" | "image/gif" | "image/webp", data: match[2] } };
  }
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new ToolError("Invalid image URL"); }
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new ToolError("Image URLs must use HTTP(S) without embedded credentials");
  }
  return { type: "image", source: { type: "url", url } };
}

export const argumentSchema = z.record(z.string(), z.unknown());
const textPart = z.object({ type: z.literal("text"), text: z.string() });
const textContent = z.union([
  z.string(), z.array(textPart).transform(parts => parts.map(part => part.text).join("\n")),
]);
const imagePart = z.object({
  type: z.literal("image_url"),
  image_url: z.object({ url: z.string(), detail: z.enum(["auto", "low", "high"]).optional() }),
}).transform(part => imageBlock(part.image_url));
const contentParts = z.array(z.union([textPart, imagePart]));
const userContent = z.union([
  z.string().transform(text => text ? [{ type: "text" as const, text }] : []),
  contentParts,
]);
const reasoning = z.discriminatedUnion("type", [
  z.object({ type: z.literal("thinking"), thinking: z.string(), signature: z.string() }),
  z.object({ type: z.literal("redacted_thinking"), data: z.string() }),
]);
const toolCall = z.object({
  id: z.string().min(1), type: z.literal("function"),
  function: z.object({ name: z.string(), arguments: z.string().transform((raw, ctx) => {
    try { return JSON.parse(raw) as unknown; }
    catch { ctx.addIssue({ code: "custom", message: "Invalid historical tool arguments" }); return z.NEVER; }
  }).pipe(argumentSchema) }),
});
const message = z.discriminatedUnion("role", [
  z.object({ role: z.literal("system"), content: textContent, tool_calls: z.never().optional() }),
  z.object({ role: z.literal("developer"), content: textContent, tool_calls: z.never().optional() }),
  z.object({ role: z.literal("user"), content: userContent, tool_calls: z.never().optional() }),
  z.object({ role: z.literal("tool"), content: z.union([z.string(), contentParts]), tool_call_id: z.string().min(1), tool_calls: z.never().optional() }),
  z.object({ role: z.literal("assistant"), content: textContent.nullish().transform(text => text ?? ""),
    tool_calls: z.array(toolCall).optional(), reasoning_details: z.array(reasoning).optional() }),
]);
const toolChoice = z.union([
  z.enum(["none", "auto", "required"]).transform(mode => ({ mode, name: undefined })),
  z.object({ type: z.literal("function"), function: z.object({ name: z.string() }) })
    .transform(choice => ({ mode: "required" as const, name: choice.function.name })),
]);
const tokenLimit = z.number().int().positive();
export const toolRequestSchema = z.object({
  messages: z.array(message).min(1), model: z.string().min(1).nullish(),
  max_completion_tokens: tokenLimit.nullish(), max_tokens: tokenLimit.nullish(),
  stream: z.boolean().optional(), parallel_tool_calls: z.boolean().optional(), n: z.literal(1).optional(),
  response_format: z.never().optional(), functions: z.never().optional(), function_call: z.never().optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
  tools: z.array(z.object({ type: z.literal("function"), function: z.object({
    name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), description: z.string().optional(),
    parameters: z.object({ type: z.literal("object") }).catchall(z.unknown())
      .nullish().transform(schema => schema ?? { type: "object" as const, properties: {} }),
  }) })).max(128).nullish().transform(tools => tools ?? []),
  tool_choice: toolChoice.nullish(),
  temperature: z.number().min(0).max(1).optional(), top_p: z.number().min(0).max(1).optional(),
  stop: z.union([z.string().min(1).transform(stop => [stop]), z.array(z.string().min(1))]).optional(),
});
export const cacheTtlSchema = z.enum(["5m", "1h", "off"]);
