import { Router } from "express";
import * as chatController from "../controllers/chat.controller";

export const chatRouter = Router();
chatRouter.post("/chat/completions", chatController.handleCompletion);
