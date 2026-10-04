import express from "express";
import cors from "cors";
import { config } from "./config";
import { AUTH_FILE } from "./lib/auth-storage";
import { authenticate, authenticateAnthropic } from "./middleware/auth";
import { healthRouter } from "./routes/health";
import { modelsRouter } from "./routes/models";
import { chatRouter } from "./routes/chat";
import { toolRouter } from "./routes/tools";
import { anthropicRouter } from "./routes/anthropic";

const app = express();
app.use(cors());

// Configure body parsers for high-capacity endpoints (32mb) and legacy limit for /v1
app.use(["/openai/v1/chat/completions", "/anthropic/v1/messages"], express.json({ limit: "32mb" }));
app.use(express.json());

app.use("/health", healthRouter);
// Models endpoints: OpenAI /openai/v1 and legacy /v1
app.use(["/openai/v1", "/v1"], modelsRouter);

// Authentication scoped to endpoints requiring proxy API key
app.post("/openai/v1/chat/completions", authenticate);
app.post("/v1/chat/completions", authenticate);
app.post("/anthropic/v1/messages", authenticateAnthropic);

// Mount routers
app.use("/openai/v1", toolRouter);
app.use("/v1", chatRouter);
app.use("/anthropic/v1", anthropicRouter);

app.listen(config.port, () => {
    console.log(`claude-ai-proxy listening on :${config.port}`);
    console.log(`auth: ${AUTH_FILE}`);
});
