import { z } from "zod";

export const cacheTtlSchema = z.enum(["5m", "1h", "off"]);
