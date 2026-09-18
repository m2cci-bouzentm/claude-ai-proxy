import express from "express";
import cors from "cors";
import { config } from "./config";
import { AUTH_FILE } from "./lib/auth-storage";
import { authenticate } from "./middleware/auth";
import { healthRouter } from "./routes/health";
import { modelsRouter } from "./routes/models";
import { chatRouter } from "./routes/chat";
import { toolRouter } from "./routes/tools";

const app = express();
app.use(cors());
// Preserve the larger tool-route limit and the legacy 100 KiB limit.
app.use("/tools/v1/chat/completions", express.json({ limit: "32mb" }));
app.use(express.json());

app.use("/health", healthRouter);
app.use(["/v1", "/tools/v1"], modelsRouter);
// Authentication stays scoped to completions; health/models remain public.
app.post("/v1/chat/completions", authenticate);
app.post("/tools/v1/chat/completions", authenticate);
app.use("/v1", chatRouter);
app.use("/tools/v1", toolRouter);

app.listen(config.port, () => {
    console.log(`claude-ai-proxy listening on :${config.port}`);
    console.log(`auth: ${AUTH_FILE}`);
});
