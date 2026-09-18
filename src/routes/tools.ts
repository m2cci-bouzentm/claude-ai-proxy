import { Router } from "express";
import { config } from "../config";
import { createToolResponse } from "../lib/claude-client";
import { createToolController } from "../controllers/tool.controller";
import { validateBody } from "../middleware/validate";
import { toolRequestSchema } from "../schemas/tool.schema";
import type { ToolTransport } from "../types/tool";

export function createToolRouter(
    transport: ToolTransport = createToolResponse,
    defaultModel = config.defaultModel,
) {
    const router = Router();
    router.post(
        "/chat/completions",
        validateBody(toolRequestSchema),
        createToolController(transport, defaultModel),
    );
    return router;
}

export const toolRouter = createToolRouter();
