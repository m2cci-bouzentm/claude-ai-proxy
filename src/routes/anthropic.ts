import { Router } from "express";
import { authenticateAnthropic } from "../middleware/auth";
import { config } from "../config";
import { proxyAnthropicMessages } from "../services/anthropic.service";

export function createAnthropicRouter() {
    const router = Router();
    const authenticate = (req: Parameters<typeof authenticateAnthropic>[0], res: Parameters<typeof authenticateAnthropic>[1], next: Parameters<typeof authenticateAnthropic>[2]) => {
        if (!config.apiKey) {
            res.status(503).json({ type: "error", error: { type: "api_error", message: "Proxy API key is not configured" } });
            return;
        }
        authenticateAnthropic(req, res, next);
    };
    const forward = (req: Parameters<typeof authenticateAnthropic>[0], res: Parameters<typeof authenticateAnthropic>[1]) => { void proxyAnthropicMessages(req, res); };
    router.post(["/v1/messages", "/v1/messages/count_tokens"], authenticate, forward);
    router.head("/api/hello", authenticate, forward);
    router.get(["/v1/models", "/v1/models/:model", "/api/oauth/usage", "/api/oauth/profile"], authenticate, forward);
    return router;
}

export const anthropicRouter = createAnthropicRouter();
