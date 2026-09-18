import type { RequestHandler } from "express";
import { config } from "../config";

export const authenticate: RequestHandler = (req, res, next) => {
    if (!config.apiKey) return next();
    const header = req.headers.authorization;
    if (!header || header !== `Bearer ${config.apiKey}`) {
        res.status(401).json({
            error: { message: "Invalid API key", type: "auth_error" },
        });
        return;
    }
    next();
};
