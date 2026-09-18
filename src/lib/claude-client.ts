import crypto from "crypto";
import { resolveModelId } from "../config/models";
import fs from "fs";
import { getAuth } from "../services/auth.service";
import { config } from "../config";
import type { AuthResult } from "../types/auth";
import type {
    LegacyMessage,
    LegacyCompletion,
    ClaudeMetadata,
    SystemPromptBlock,
} from "../types/chat";
import type { NativeRequest } from "../types/tool";

const API_URL = "https://api.anthropic.com/v1/messages?beta=true";

const BETAS = [
    "claude-code-20250219",
    "oauth-2025-04-20",
    "interleaved-thinking-2025-05-14",
    "thinking-token-count-2026-05-13",
    "context-management-2025-06-27",
    "prompt-caching-scope-2026-01-05",
    "advisor-tool-2026-03-01",
    "advanced-tool-use-2025-11-20",
    "effort-2025-11-24",
    "afk-mode-2026-01-31",
    "extended-cache-ttl-2025-04-11",
    "cache-diagnosis-2026-04-07",
];

const SYSTEM_PROMPT = JSON.parse(
    fs.readFileSync(config.systemPromptPath, "utf-8"),
);

function buildHeaders(auth: AuthResult): Record<string, string> {
    return {
        Authorization: `Bearer ${auth.accessToken}`,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": BETAS.join(","),
        "anthropic-dangerous-direct-browser-access": "true",
        "x-app": "cli",
        "x-client-request-id": crypto.randomUUID(),
        "X-Claude-Code-Session-Id": crypto.randomUUID(),
        "X-Stainless-Lang": "js",
        "X-Stainless-Package-Version": "0.94.0",
        "X-Stainless-Runtime": "node",
        "X-Stainless-Runtime-Version": process.versions.node,
        "X-Stainless-Retry-Count": "0",
        "User-Agent": "claude-cli/2.1.160 (external, sdk-cli)",
    };
}

function buildMetadata(): ClaudeMetadata {
    return {
        user_id: JSON.stringify({
            device_id: config.deviceId,
            account_uuid: config.accountUuid,
            session_id: crypto.randomUUID(),
        }),
    };
}

function convertMessages(messages: LegacyMessage[]): LegacyMessage[] {
    return messages
        .filter((m) => m.role !== "system")
        .map((m) => {
            const text =
                typeof m.content === "string"
                    ? m.content
                    : m.content
                          .filter((c) => c.type === "text")
                          .map((c) => c.text)
                          .join("\n");
            return {
                role: m.role === "assistant" ? "assistant" : "user",
                content: text,
            };
        });
}

function parseSSE(body: string): LegacyCompletion {
    let content = "";
    const usage = { input_tokens: 0, output_tokens: 0 };
    for (const line of body.split("\n")) {
        if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
        try {
            const evt = JSON.parse(line.slice(6));
            if (
                evt.type === "content_block_delta" &&
                evt.delta?.type === "text_delta"
            ) {
                content += evt.delta.text || "";
            }
            if (evt.type === "message_start")
                usage.input_tokens = evt.message?.usage?.input_tokens || 0;
            if (evt.type === "message_delta")
                usage.output_tokens = evt.usage?.output_tokens || 0;
        } catch {}
    }
    return { content, usage };
}

async function callAPI(
    messages: LegacyMessage[],
    model: string,
    maxTokens: number,
): Promise<Response> {
    const auth = await getAuth();

    const body: Record<string, unknown> = {
        model: resolveModelId(model),
        max_tokens: maxTokens,
        messages: convertMessages(messages),
        system: SYSTEM_PROMPT,
        stream: true,
        metadata: buildMetadata(),
    };
    if (!model.includes("haiku")) body.thinking = { type: "adaptive" };

    const resp = await fetch(API_URL, {
        method: "POST",
        headers: buildHeaders(auth),
        body: JSON.stringify(body),
    });

    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Claude API ${resp.status}: ${text}`);
    }
    return resp;
}

export async function createCompletion(
    messages: LegacyMessage[],
    model: string,
    maxTokens: number = 32000,
): Promise<LegacyCompletion> {
    const resp = await callAPI(messages, model, maxTokens);
    return parseSSE(await resp.text());
}

export async function createStreamingResponse(
    messages: LegacyMessage[],
    model: string,
    maxTokens: number = 32000,
): Promise<Response> {
    return callAPI(messages, model, maxTokens);
}

// The opt-in tool route shares auth and transport identity, never the legacy
// text conversion/parser. Keep callAPI and both existing exports unchanged.
export async function createToolResponse(
    request: NativeRequest,
    signal: AbortSignal,
): Promise<Response> {
    const auth = await getAuth();
    // Keep the opt-in transport identity consistent with its trusted billing
    // preamble; legacy headers and prompt retain their existing version.
    const toolClientVersion = "2.1.251";
    const system = (
        Array.isArray(SYSTEM_PROMPT)
            ? SYSTEM_PROMPT
            : [{ type: "text", text: SYSTEM_PROMPT }]
    ).map((block: SystemPromptBlock) =>
        block.type === "text" &&
        block.text?.startsWith("x-anthropic-billing-header:")
            ? {
                  ...block,
                  text: block.text.replace(
                      /cc_version=\d+\.\d+\.\d+/,
                      `cc_version=${toolClientVersion}`,
                  ),
              }
            : block,
    );
    // Only the trusted, bundled prompt belongs here. Even if an internal caller
    // supplies request.system, the fixed system below overrides it.
    return fetch(API_URL, {
        method: "POST",
        headers: {
            ...buildHeaders(auth),
            "User-Agent": `claude-cli/${toolClientVersion} (external, sdk-cli)`,
        },
        body: JSON.stringify({
            ...request,
            system,
            stream: true,
            metadata: buildMetadata(),
        }),
        signal,
    });
}
