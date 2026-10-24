import type { Response } from "express"
import { getUpstreamTimeoutMs } from "../config"
import type { RequestCancellation } from "../types/http"

// Aborts on client disconnect, or when upstream stays silent for the idle timeout.
export function createRequestCancellation(res: Response): RequestCancellation {
  const controller = new AbortController()
  const timeoutMs = getUpstreamTimeoutMs()
  let timeout = setTimeout(() => controller.abort(), timeoutMs)
  const disconnect = () => {
    if (!res.writableEnded) controller.abort()
  }
  res.on("close", disconnect)
  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    touch: () => {
      clearTimeout(timeout)
      timeout = setTimeout(() => controller.abort(), timeoutMs)
    },
    dispose: () => {
      clearTimeout(timeout)
      res.off("close", disconnect)
    },
  }
}
