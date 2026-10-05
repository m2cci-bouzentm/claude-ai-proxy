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

import { ANTHROPIC_BETAS as BETAS } from "./anthropic-betas";

// Upstream gates newer models on the Claude Code version it sees in the
// User-Agent and billing header. Keep it at the current installed CLI.
const CLAUDE_CODE_VERSION = "2.1.280";

const SYSTEM_PROMPT: SystemPromptBlock[] = (() => {
    const raw = JSON.parse(fs.readFileSync(config.systemPromptPath, "utf-8"));
    const blocks: SystemPromptBlock[] = Array.isArray(raw)
        ? raw
        : [{ type: "text", text: raw }];
    return blocks.map((block) =>
        block.type === "text" &&
        block.text?.startsWith("x-anthropic-billing-header:")
            ? {
                  ...block,
                  text: block.text.replace(
                      /cc_version=\d+\.\d+\.\d+/,
                      `cc_version=${CLAUDE_CODE_VERSION}`,
                  ),
              }
            : block,
    );
})();

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
        "User-Agent": `claude-cli/${CLAUDE_CODE_VERSION} (external, sdk-cli)`,
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
    const { system: consumerSystem, ...payload } = request;
    const consumerBlocks = Array.isArray(consumerSystem)
        ? consumerSystem
        : consumerSystem
          ? [{ type: "text" as const, text: consumerSystem }]
          : [];
    // Keep trusted, version-normalized billing prompt first; append caller
    // system/developer instructions without allowing replacement.
    return fetch(API_URL, {
        method: "POST",
        headers: buildHeaders(auth),
        body: JSON.stringify({
            ...payload,
            system: [...SYSTEM_PROMPT, ...consumerBlocks],
            stream: true,
            metadata: buildMetadata(),
        }),
        signal,
    });
}
