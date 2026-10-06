import { Router } from "express"
import { config } from "../config"
import { createToolResponse } from "../lib/claude-client"
import { createOpenAIController, listModels } from "../controllers/openai.controller"
import { validateBody } from "../middleware/validate"
import { openAIRequestSchema } from "../schemas/openai.schema"
import { openAIChatRequestContractSchema } from "../schemas/contracts.schema"
import type { ToolTransport } from "../types/openai"

export function createOpenAIRouter(transport: ToolTransport = createToolResponse, defaultModel = config.defaultModel) {
  const router = Router()
  router.get("/models", listModels)
  router.post(
    "/chat/completions",
    validateBody(openAIChatRequestContractSchema),
    validateBody(openAIRequestSchema),
    createOpenAIController(transport, defaultModel),
  )
  return router
}

export const openaiRouter = createOpenAIRouter()
