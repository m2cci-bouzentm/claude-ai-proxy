import type { RequestHandler } from "express"
import { proxyAnthropicMessages } from "../services/anthropic.service"

export const anthropicMessages: RequestHandler = (req, res) => {
  void proxyAnthropicMessages(req, res)
}

// Claude upstream handles messages, token counts, models, profile and usage
// through one authenticated protocol-preserving transport.
export const anthropicGateway = anthropicMessages
