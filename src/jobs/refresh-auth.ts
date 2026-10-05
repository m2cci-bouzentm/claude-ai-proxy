import { getAuth } from "../services/auth.service";
import type { JobConfig } from "./types";

// Refresh the OAuth access token ahead of expiry even when no requests arrive.
// getAuth only hits the token endpoint when within this buffer of expiry,
// so most ticks are no-ops.
const PROACTIVE_BUFFER_MS = 30 * 60 * 1000;

export const config: JobConfig = {
    name: "refresh-auth",
    schedule: "*/5 * * * *",
};

export default async function run(): Promise<void> {
    await getAuth(PROACTIVE_BUFFER_MS);
}
