import type { Response } from "express";
import { ProxyError } from "../errors/proxy-error";
import { ToolError } from "../errors/tool-error";

export function sendToolError(res: Response, error: unknown): void {
    if (res.destroyed) return;
    const known = error instanceof ToolError || error instanceof ProxyError;
    const status = known
        ? error.status
        : error instanceof Error && error.name === "AbortError"
          ? 504
          : 502;
    const message = known ? error.message : "Tool request failed or timed out";
    let type = status < 500 ? "invalid_request_error" : "upstream_error";
    if (status === 429) type = "rate_limit_error";
    if (error instanceof ProxyError) type = error.type;
    if (res.headersSent) {
        res.end(`data: ${JSON.stringify({ error: { message, type } })}\n\n`);
        return;
    }
    if (error instanceof ProxyError && error.retryAfter)
        res.setHeader("Retry-After", error.retryAfter);
    res.status(status).json({
        error: {
            message,
            type,
        },
    });
}
