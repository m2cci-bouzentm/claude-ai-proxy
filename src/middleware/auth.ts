import type { RequestHandler } from "express"
import { config } from "../config"

export const authenticate: RequestHandler = (req, res, next) => {
  if (!config.apiKey) return next()
  if (req.headers.authorization !== `Bearer ${config.apiKey}`) {
    res.status(401).json({ error: { message: "Invalid API key", type: "auth_error" } })
    return
  }
  next()
}

export const authenticateAnthropic: RequestHandler = (req, res, next) => {
  if (!config.apiKey) return next()
  const valid = req.headers.authorization === `Bearer ${config.apiKey}` || req.headers["x-api-key"] === config.apiKey
  if (!valid) {
    res.status(401).json({
      type: "error",
      error: {
        type: "authentication_error",
        message: "Invalid proxy API key",
      },
    })
    return
  }
  next()
}
