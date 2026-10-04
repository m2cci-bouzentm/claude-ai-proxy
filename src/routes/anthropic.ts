import { Router } from "express";
import { authenticateAnthropic } from "../middleware/auth";
import { config } from "../config";
import { proxyAnthropicMessages } from "../services/anthropic.service";

export function createAnthropicRouter() {
    const router = Router();
    router.post("/messages", (req, res, next) => {
        if (!config.apiKey) {
            res.status(503).json({ type: "error", error: { type: "api_error", message: "Proxy API key is not configured" } });
            return;
        }
        authenticateAnthropic(req, res, next);
    }, (req, res) => {
        void proxyAnthropicMessages(req, res);
    });
    return router;
}

export const anthropicRouter = createAnthropicRouter();
