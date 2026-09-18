import type { TokenResponse, AuthResult, OAuthEntry } from "../types/auth";
import * as storage from "../lib/auth-storage";
import {
    readClaudeCredentials,
    deleteClaudeCredentials,
} from "../lib/keychain";

const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const SCOPES = [
    "user:profile",
    "user:inference",
    "user:sessions:claude_code",
    "user:mcp_servers",
    "user:file_upload",
];

export { AUTH_FILE } from "../lib/auth-storage";

// First run: seeds from Claude Code (keychain on macOS, plaintext on Linux),
// then deletes the source so user can /login fresh for an independent CLI token.
// After seed, refreshes independently via ~/.claude-proxy/auth.json.

function seedFromClaude(): OAuthEntry {
    const tokens = readClaudeCredentials();
    if (!tokens?.accessToken) {
        throw new Error(
            "No Claude Code credentials found.\n" +
                "Run `claude` and log in first, then restart the proxy.",
        );
    }
    const entry: OAuthEntry = {
        type: "oauth",
        access: tokens.accessToken,
        refresh: tokens.refreshToken,
        expires: tokens.expiresAt,
        scopes: tokens.scopes,
        subscriptionType: tokens.subscriptionType,
        rateLimitTier: tokens.rateLimitTier,
    };
    storage.write(entry);
    console.log("[auth] seeded from Claude Code, stored in", storage.AUTH_FILE);

    if (deleteClaudeCredentials()) {
        console.log(
            "[auth] deleted Claude Code credentials — run `claude` and /login for independent CLI token",
        );
    }

    return entry;
}

async function refreshAccessToken(
    refreshToken: string,
): Promise<TokenResponse> {
    const resp = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: CLIENT_ID,
            scope: SCOPES.join(" "),
        }),
    });
    if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`Token refresh failed (${resp.status}): ${body}`);
    }
    return resp.json();
}

let currentAuth: OAuthEntry | null = null;
let refreshPromise: Promise<void> | null = null;

export async function getAuth(): Promise<AuthResult> {
    currentAuth ??= storage.read() ?? seedFromClaude();

    const BUFFER_MS = 5 * 60 * 1000;
    const needsRefresh =
        !currentAuth.access || currentAuth.expires < Date.now() + BUFFER_MS;
    if (!needsRefresh) {
        return {
            accessToken: currentAuth.access,
            subscriptionType: currentAuth.subscriptionType,
            rateLimitTier: currentAuth.rateLimitTier,
        };
    }

    refreshPromise ??= refreshAccessToken(currentAuth.refresh)
        .then((tokens) => {
            currentAuth = {
                type: "oauth",
                access: tokens.access_token,
                refresh: tokens.refresh_token || currentAuth!.refresh,
                expires: Date.now() + tokens.expires_in * 1000,
                scopes: tokens.scope?.split(" ") || currentAuth!.scopes,
                subscriptionType: currentAuth!.subscriptionType,
                rateLimitTier: currentAuth!.rateLimitTier,
            };
            storage.write(currentAuth);
            console.log(
                `[auth] refreshed, expires ${new Date(currentAuth.expires).toISOString()}`,
            );
        })
        .catch((err) => {
            console.error(`[auth] refresh failed: ${err.message}`);
            throw err;
        })
        .finally(() => {
            refreshPromise = null;
        });

    await refreshPromise;
    return {
        accessToken: currentAuth!.access,
        subscriptionType: currentAuth!.subscriptionType,
        rateLimitTier: currentAuth!.rateLimitTier,
    };
}

export function clearAuth(): void {
    currentAuth = null;
}
