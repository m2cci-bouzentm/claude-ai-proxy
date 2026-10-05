import fs from "fs";
import path from "path";
import type { OAuthEntry, AuthStatus } from "../types/auth";

export function getAuthDir(): string {
    return process.env.PROXY_AUTH_DIR || process.env.CLAUDE_PROXY_HOME || "/data";
}

export function getAuthFile(): string {
    return path.join(getAuthDir(), "auth.json");
}

// Deprecated alias for backward compatibility
export const AUTH_FILE = getAuthFile();

export function ensureAuthDir(): string {
    const dir = getAuthDir();
    const oldUmask = process.umask(0o077);
    try {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        } else {
            try {
                fs.chmodSync(dir, 0o700);
            } catch {
                // Best effort if permissions cannot be modified
            }
        }
    } finally {
        process.umask(oldUmask);
    }
    return dir;
}

export function assertSafeFile(filePath: string): void {
    if (!fs.existsSync(filePath)) return;
    const lstat = fs.lstatSync(filePath);
    if (lstat.isSymbolicLink()) {
        throw new Error(`Insecure file path: ${filePath} is a symlink`);
    }
    if (!lstat.isFile()) {
        throw new Error(`Insecure file path: ${filePath} is not a regular file`);
    }
}

export function read(): OAuthEntry | null {
    const file = getAuthFile();
    if (!fs.existsSync(file)) return null;
    assertSafeFile(file);
    try {
        const raw = fs.readFileSync(file, "utf-8");
        const parsed = JSON.parse(raw);
        if (
            parsed &&
            typeof parsed === "object" &&
            parsed.type === "oauth" &&
            typeof parsed.access === "string" &&
            typeof parsed.refresh === "string"
        ) {
            return {
                type: "oauth",
                access: parsed.access,
                refresh: parsed.refresh,
                expires: typeof parsed.expires === "number" ? parsed.expires : 0,
                scopes: Array.isArray(parsed.scopes) ? parsed.scopes : undefined,
                subscriptionType: parsed.subscriptionType ?? null,
                rateLimitTier: parsed.rateLimitTier ?? null,
            };
        }
        return null;
    } catch {
        return null;
    }
}

export function write(entry: OAuthEntry): void {
    const dir = ensureAuthDir();
    const file = getAuthFile();
    assertSafeFile(file);

    const oldUmask = process.umask(0o077);
    const tempFile = path.join(
        dir,
        `.auth.json.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`,
    );
    try {
        fs.writeFileSync(tempFile, JSON.stringify(entry, null, 2), {
            mode: 0o600,
            encoding: "utf-8",
        });
        fs.chmodSync(tempFile, 0o600);
        fs.renameSync(tempFile, file);
        fs.chmodSync(file, 0o600);
    } finally {
        process.umask(oldUmask);
        if (fs.existsSync(tempFile)) {
            try {
                fs.unlinkSync(tempFile);
            } catch {}
        }
    }
}

export function normalizeAndSave(data: unknown): OAuthEntry {
    if (!data || typeof data !== "object") {
        throw new Error("Invalid credential data: expected JSON object");
    }

    const obj = data as Record<string, any>;

    // Case 1: Native Claude credentials structure: {"claudeAiOauth": {"accessToken", "refreshToken", "expiresAt", "scopes", ...}}
    if (obj.claudeAiOauth && typeof obj.claudeAiOauth === "object") {
        const {
            accessToken,
            refreshToken,
            expiresAt,
            scopes,
            subscriptionType,
            rateLimitTier,
        } = obj.claudeAiOauth;
        if (
            !accessToken ||
            typeof accessToken !== "string" ||
            !refreshToken ||
            typeof refreshToken !== "string"
        ) {
            throw new Error(
                "Invalid native Claude credential: empty or missing accessToken/refreshToken",
            );
        }

        const entry: OAuthEntry = {
            type: "oauth",
            access: accessToken,
            refresh: refreshToken,
            expires:
                typeof expiresAt === "number"
                    ? expiresAt
                    : Date.now() + 3600 * 1000,
            scopes: Array.isArray(scopes) ? scopes : undefined,
            subscriptionType: subscriptionType ?? null,
            rateLimitTier: rateLimitTier ?? null,
        };
        write(entry);
        return entry;
    }

    // Case 2: Normalized OAuth structure: {"type":"oauth", "access", "refresh", "expires", ...}
    if (obj.type === "oauth" || (obj.access && obj.refresh)) {
        if (
            !obj.access ||
            typeof obj.access !== "string" ||
            !obj.refresh ||
            typeof obj.refresh !== "string"
        ) {
            throw new Error(
                "Invalid normalized OAuth credential: empty or missing access/refresh",
            );
        }

        const entry: OAuthEntry = {
            type: "oauth",
            access: obj.access,
            refresh: obj.refresh,
            expires:
                typeof obj.expires === "number"
                    ? obj.expires
                    : Date.now() + 3600 * 1000,
            scopes: Array.isArray(obj.scopes) ? obj.scopes : undefined,
            subscriptionType: obj.subscriptionType ?? null,
            rateLimitTier: obj.rateLimitTier ?? null,
        };
        write(entry);
        return entry;
    }

    throw new Error(
        "Invalid credential format: unrecognized schema (expected native Claude claudeAiOauth or normalized oauth)",
    );
}

export function getStatus(): AuthStatus {
    const entry = read();
    if (!entry) {
        return { configured: false };
    }

    const isExpired =
        typeof entry.expires === "number" && entry.expires <= Date.now();
    return {
        configured: true,
        type: entry.type || "oauth",
        expiresAt: entry.expires ? new Date(entry.expires).toISOString() : undefined,
        isExpired,
        scopes: entry.scopes,
        subscriptionType: entry.subscriptionType,
        rateLimitTier: entry.rateLimitTier,
    };
}
