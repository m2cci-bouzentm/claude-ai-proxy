import type { RequestHandler } from "express";
import type { ZodType } from "zod";
import { ToolError } from "../errors/tool-error";
import { sendToolError } from "../utils/tool-error";

export function validateBody<T>(schema: ZodType<T>): RequestHandler {
    return (req, res, next) => {
        try {
            const result = schema.safeParse(req.body);
            if (!result.success) {
                const details = result.error.issues
                    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
                    .join("; ");
                throw new ToolError(`Invalid request: ${details}`);
            }
            req.body = result.data;
            next();
        } catch (error) {
            sendToolError(res, error);
        }
    };
}
