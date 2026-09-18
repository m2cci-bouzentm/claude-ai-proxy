import "dotenv/config";
import crypto from "crypto";
import os from "os";
import path from "path";
import { cacheTtlSchema } from "../schemas/config.schema";
import { ToolError } from "../errors/tool-error";

export const config = {
    apiKey: process.env.API_KEY,
    defaultModel: process.env.DEFAULT_MODEL || "claude-sonnet-4-6",
    port: process.env.PORT || 4181,
    systemPromptPath:
        process.env.SYSTEM_PROMPT_PATH ||
        path.join(__dirname, "..", "..", "data", "system_prompt.json"),
    accountUuid: process.env.ACCOUNT_UUID || "",
    deviceId: process.env.DEVICE_ID || crypto.randomBytes(32).toString("hex"),
    authDir:
        process.env.CLAUDE_PROXY_HOME ||
        path.join(os.homedir(), ".claude-proxy"),
    claudeHome:
        process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
    toolRequestTimeoutMs: 120_000,
    toolResponseByteLimit: 8 * 1024 * 1024,
} as const;

export function getToolCacheTtl() {
    const result = cacheTtlSchema.safeParse(
        process.env.TOOL_PROMPT_CACHE_TTL ?? "5m",
    );
    if (!result.success)
        throw new ToolError("TOOL_PROMPT_CACHE_TTL must be 5m, 1h or off", 500);
    return result.data;
}
