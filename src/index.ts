import express from "express";
import cors from "cors";
import "dotenv/config";

import { createCompletion, createStreamingResponse, createToolResponse } from "./claude";
import { createToolHandler } from "./tool-route";
import { AUTH_FILE, getAuth } from "./auth";

const app = express();
app.use(cors());
// Larger agent histories are opt-in; preserve the legacy parser's 100 KiB limit.
app.use("/tools/v1/chat/completions", express.json({ limit: "32mb" }));
app.use(express.json());

const API_KEY = process.env.API_KEY;
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "claude-sonnet-4-6";
const PORT = process.env.PORT || 4181;


function auth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!API_KEY) return next();
  const header = req.headers.authorization;
  if (!header || header !== `Bearer ${API_KEY}`) {
    res.status(401).json({ error: { message: "Invalid API key", type: "auth_error" } });
    return;
  }
  next();
}

app.get("/health", async (_req, res) => {
  try {
    const authInfo = await getAuth();
    res.json({ status: "ok", subscription: authInfo.subscriptionType, rateLimitTier: authInfo.rateLimitTier });
  } catch (err) {
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

app.get(["/v1/models", "/tools/v1/models"], (_req, res) => {
  res.json({
    object: "list",
    data: [
      { id: "claude-opus-4-8", object: "model", created: 1700000000, owned_by: "anthropic" },
      { id: "claude-opus-4-7", object: "model", created: 1700000000, owned_by: "anthropic" },
      { id: "claude-opus-4-6", object: "model", created: 1700000000, owned_by: "anthropic" },
      { id: "claude-sonnet-4-6", object: "model", created: 1700000000, owned_by: "anthropic" },
      { id: "claude-sonnet-4-5-20250929", object: "model", created: 1700000000, owned_by: "anthropic" },
      { id: "claude-haiku-4-5-20251001", object: "model", created: 1700000000, owned_by: "anthropic" },
    ],
  });
});

function toOpenAIChunk(model: string, content: string | null, finish: string | null) {
  return JSON.stringify({
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      delta: content !== null ? { content } : {},
      finish_reason: finish,
    }],
  });
}

async function handleStream(res: express.Response, messages: unknown[], model: string, maxTokens: number) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const streamResp = await createStreamingResponse(messages as any, model, maxTokens);
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
          if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
            res.write(`data: ${toOpenAIChunk(model, evt.delta.text, null)}\n\n`);
          }
          if (evt.type === "message_stop") {
            res.write(`data: ${toOpenAIChunk(model, null, "stop")}\n\n`);
            res.write("data: [DONE]\n\n");
          }
        } catch {}
      }
    }
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: { message: (err as Error).message } })}\n\n`);
  }
  res.end();
}

app.post("/v1/chat/completions", auth, async (req, res) => {
  const { messages, model, max_tokens, max_completion_tokens, stream } = req.body;

  if (!messages || !messages.length) {
    res.status(400).json({ error: { message: "messages is required", type: "invalid_request" } });
    return;
  }

  const selectedModel = model || DEFAULT_MODEL;
  const maxTokens = max_tokens || max_completion_tokens || 8192;

  if (stream) return handleStream(res, messages, selectedModel, maxTokens);

  try {
    const { content, usage } = await createCompletion(messages, selectedModel, maxTokens);
    res.json({
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: selectedModel,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
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
});

app.post("/tools/v1/chat/completions", auth, createToolHandler(createToolResponse, DEFAULT_MODEL));

app.listen(PORT, () => {
  console.log(`claude-ai-proxy listening on :${PORT}`);
  console.log(`auth: ${AUTH_FILE}`);
});
