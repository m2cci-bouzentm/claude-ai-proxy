import type { Response } from "express";
import { config } from "../config";
import type { RequestCancellation } from "../types/http";

export function createRequestCancellation(res: Response): RequestCancellation {
    const controller = new AbortController();
    const timeout = setTimeout(
        () => controller.abort(),
        config.toolRequestTimeoutMs,
    );
    const disconnect = () => {
        if (!res.writableEnded) controller.abort();
    };
    res.on("close", disconnect);
    return {
        signal: controller.signal,
        abort: () => controller.abort(),
        dispose: () => {
            clearTimeout(timeout);
            res.off("close", disconnect);
        },
    };
}
