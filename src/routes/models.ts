import { Router } from "express";

export const modelsRouter = Router();

modelsRouter.get("/models", (_req, res) => {
    res.json({
        object: "list",
        data: [
            {
                id: "claude-opus-4-8",
                object: "model",
                created: 1700000000,
                owned_by: "anthropic",
            },
            {
                id: "claude-opus-4-7",
                object: "model",
                created: 1700000000,
                owned_by: "anthropic",
            },
            {
                id: "claude-opus-4-6",
                object: "model",
                created: 1700000000,
                owned_by: "anthropic",
            },
            {
                id: "claude-sonnet-4-6",
                object: "model",
                created: 1700000000,
                owned_by: "anthropic",
            },
            {
                id: "claude-sonnet-4-5-20250929",
                object: "model",
                created: 1700000000,
                owned_by: "anthropic",
            },
            {
                id: "claude-haiku-4-5-20251001",
                object: "model",
                created: 1700000000,
                owned_by: "anthropic",
            },
        ],
    });
});
