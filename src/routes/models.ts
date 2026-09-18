import { Router } from "express";
import { modelIds } from "../config/models";

export const modelsRouter = Router();

modelsRouter.get("/models", (_req, res) => {
    res.json({
        object: "list",
        data: modelIds.map((id) => ({
            id,
            object: "model",
            created: 1700000000,
            owned_by: "anthropic",
        })),
    });
});
