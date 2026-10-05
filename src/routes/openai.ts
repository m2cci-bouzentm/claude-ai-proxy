import { Router } from "express";
import { config } from "../config";
import { createToolResponse } from "../lib/claude-client";
import { createOpenAIController } from "../controllers/openai.controller";
import { validateBody } from "../middleware/validate";
import { openAIRequestSchema } from "../schemas/openai.schema";
import { modelsRouter } from "./models";
import type { ToolTransport } from "../types/tool";

export function createOpenAIRouter(
    transport: ToolTransport = createToolResponse,
    defaultModel = config.defaultModel,
) {
    const router = Router();
    router.use(modelsRouter);
    router.post(
        "/chat/completions",
        validateBody(openAIRequestSchema),
        createOpenAIController(transport, defaultModel),
    );
    return router;
}

export const openaiRouter = createOpenAIRouter();
export const createToolRouter = createOpenAIRouter;
export const toolRouter = openaiRouter;
