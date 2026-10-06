import express from "express"
import cors from "cors"
import { config } from "./config"
import { AUTH_FILE } from "./lib/auth-storage"
import { authenticate } from "./middleware/auth"
import { healthRouter } from "./routes/health"
import { openaiRouter } from "./routes/openai"
import { anthropicRouter } from "./routes/anthropic"
import { startJobs } from "./jobs"

const app = express()
app.use(cors())

// Configure body parsers for high-capacity inference endpoints (32mb)
app.use(["/openai/v1/chat/completions", "/anthropic"], express.json({ limit: "32mb" }))
app.use(express.json())

app.use("/health", healthRouter)

// Authentication scoped to endpoints requiring proxy API key
app.post("/openai/v1/chat/completions", authenticate)

// Mount routers
app.use("/openai/v1", openaiRouter)
app.use("/anthropic", anthropicRouter)

app.listen(config.port, () => {
  console.log(`claude-ai-proxy listening on :${config.port}`)
  console.log(`auth: ${AUTH_FILE}`)
  startJobs()
})
