import type { Response } from "express";
import { ToolError } from "../errors/tool-error";

export function sendToolError(res: Response, error: unknown): void {
    if (res.destroyed) return;
    const status =
        error instanceof ToolError
            ? error.status
            : error instanceof Error && error.name === "AbortError"
              ? 504
              : 502;
    const message =
        error instanceof ToolError
            ? error.message
            : "Tool request failed or timed out";
    let type = status < 500 ? "invalid_request_error" : "upstream_error";
    if (status === 429) type = "rate_limit_error";
    if (res.headersSent) {
        res.end(`data: ${JSON.stringify({ error: { message, type } })}\n\n`);
        return;
    }
    res.status(status).json({
        error: {
            message,
            type,
        },
    });
}
