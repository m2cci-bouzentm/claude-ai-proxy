import type { TokenResponse, AuthResult, OAuthEntry } from "../types/auth";
import { tokenResponseSchema } from "../schemas/auth.schema";
import * as storage from "../lib/auth-storage";
import { readClaudeCredentials } from "../lib/keychain";
import { config } from "../config";
import path from "path";

export { AUTH_FILE } from "../lib/auth-storage";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
let currentAuth: OAuthEntry | null = null;
let generation: string | null = null;
let initialized = false;
let epoch = 0;
let pending: { generation: string; epoch: number; promise: Promise<void> } | null = null;
function reload(): void {
    const snapshot = storage.readSnapshot();
    currentAuth = snapshot?.entry ?? null;
    generation = snapshot?.generation ?? null;
}
function initialize(): void {
    if (initialized) return;
    initialized = true;
    // Never fall back from invalid canonical credentials, or after deletion.
    if (!storage.canonicalMissing()) return;
    let data: unknown;
    if (process.platform === "darwin") {
        const tokens = readClaudeCredentials();
        data = { claudeAiOauth: tokens };
    } else {
        data = storage.readSecureJson(path.join(config.claudeHome, ".credentials.json")).data;
    }
    const entry = storage.normalize(data);
    if (storage.canonicalMissing()) storage.write(entry);
}
function result(): AuthResult {
    if (!currentAuth?.access) throw new Error("No valid Claude credentials configured. Run proxy-auth login or import.");
    return { accessToken: currentAuth.access, subscriptionType: currentAuth.subscriptionType, rateLimitTier: currentAuth.rateLimitTier };
}
export async function getAuth(bufferMs = 5 * 60 * 1000): Promise<AuthResult> {
    initialize();
    reload();
    if (!currentAuth || !generation) throw new Error("No valid Claude credentials configured. Run proxy-auth login or import.");
    if (currentAuth.access && currentAuth.expires >= Date.now() + bufferMs) return result();
    if (!currentAuth.refresh) {
        if (currentAuth.expires > Date.now()) return result();
        throw new Error("Claude access token expired; no refresh token available");
    }
    const snapshot = currentAuth, expected = generation, expectedEpoch = epoch;
    if (!pending || pending.generation !== expected || pending.epoch !== expectedEpoch) {
        const operation = { generation: expected, epoch: expectedEpoch, promise: Promise.resolve() };
        operation.promise = (async () => {
            const response = await fetch(TOKEN_URL, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ grant_type: "refresh_token", refresh_token: snapshot.refresh, client_id: CLIENT_ID, scope: "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload" }),
            });
            if (!response.ok) throw new Error(`Claude OAuth refresh failed (${response.status})`);
            const rawTokens = await response.json();
            const parsed = tokenResponseSchema.safeParse(rawTokens);
            if (!parsed.success) throw new Error("Invalid OAuth refresh response");
            const tokens = parsed.data;
            const next = storage.normalize({ ...snapshot, access: tokens.access_token, refresh: tokens.refresh_token ?? snapshot.refresh, expires: Date.now() + tokens.expires_in * 1000, scopes: tokens.scope === undefined ? snapshot.scopes : tokens.scope.split(/\s+/).filter(Boolean) });
            // Last synchronous operation before write: compare canonical file and local invalidation generation.
            const latest = storage.readSnapshot();
            if (epoch !== expectedEpoch || latest?.generation !== expected) { reload(); return; }
            storage.write(next);
            reload();
        })().finally(() => { if (pending === operation) pending = null; });
        pending = operation;
    }
    await pending.promise;
    reload();
    return result();
}
export function clearAuth(): void { epoch++; currentAuth = null; generation = null; }
