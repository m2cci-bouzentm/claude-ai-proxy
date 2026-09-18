import { Router } from "express";
import { getAuth } from "../services/auth.service";

export const healthRouter = Router();

healthRouter.get("/", async (_req, res) => {
    try {
        const authInfo = await getAuth();
        res.json({
            status: "ok",
            subscription: authInfo.subscriptionType,
            rateLimitTier: authInfo.rateLimitTier,
        });
    } catch (err) {
        res.status(500).json({
            status: "error",
            message: (err as Error).message,
        });
    }
});
