import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ensureAuthDir, normalizeAndSave, getStatus } from "./lib/auth-storage";
import type { AuthStatus } from "./types/auth";
import { tokenWizardValuesSchema, type TokenWizardValues } from "./schemas/auth.schema";
export type { TokenWizardValues };

export interface RunLoginOptions {
    browser?: boolean;
    sso?: boolean;
    console?: boolean;
    email?: string;
}

export function runStatus(): AuthStatus {
    return getStatus();
}

const MAX_IMPORT_BYTES = 64 * 1024;

function readBounded(source: string): string {
    let fd: number | undefined;
    const ownsFd = source !== "-";
    try {
        fd = ownsFd ? fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK) : 0;
        const stat = fs.fstatSync(fd);
        if (ownsFd && !stat.isFile()) throw new Error("Import source must be a regular file");
        if (stat.size > MAX_IMPORT_BYTES) throw new Error("Credentials exceed 64 KiB limit");
        const buffer = Buffer.alloc(MAX_IMPORT_BYTES + 1);
        let used = 0;
        while (used < buffer.length) {
            const count = fs.readSync(fd, buffer, used, buffer.length - used, null);
            if (!count) break;
            used += count;
        }
        if (used > MAX_IMPORT_BYTES) throw new Error("Credentials exceed 64 KiB limit");
        return buffer.subarray(0, used).toString("utf8");
    } catch (err: any) {
        if (err.code === "ELOOP") throw new Error("Import source must not be a symlink");
        if (err.code) throw new Error("Unable to read credential import source");
        throw err;
    } finally {
        if (ownsFd && fd !== undefined) fs.closeSync(fd);
    }
}

export function runImport(source: string): AuthStatus {
    const content = readBounded(source);
    let parsed;
    try { parsed = JSON.parse(content); }
    catch { throw new Error("Invalid credential JSON"); }
    normalizeAndSave(parsed);
    return runStatus();
}
function parseExpiry(raw: string, access: string): number {
    const value = raw.trim();
    if (value) {
        const numeric = Number(value);
        const parsed = Number.isFinite(numeric) ? (numeric < 1e12 ? numeric * 1000 : numeric) : Date.parse(value);
        if (!Number.isFinite(parsed) || !Number.isFinite(new Date(parsed).getTime())) throw new Error("Invalid expiry; use ISO date, epoch seconds, or epoch milliseconds");
        return parsed;
    }
    if (!access) return 0;
    throw new Error("Expiry is required when importing an access token");
}

export function runTokenWizardImport(values: TokenWizardValues): AuthStatus {
    const validated = tokenWizardValuesSchema.parse(values);
    const access = validated.access.trim(), refresh = validated.refresh.trim();
    normalizeAndSave({ type: "oauth", access, refresh, expires: parseExpiry(validated.expires ?? "", access),
        scopes: [], subscriptionType: null, rateLimitTier: null });
    return getStatus();
}

export function runLogin(options: RunLoginOptions = {}): AuthStatus {
    const authDir = ensureAuthDir();
    const isolatedConfigDir = path.join(authDir, ".claude");
    if (!fs.existsSync(isolatedConfigDir)) fs.mkdirSync(isolatedConfigDir, { mode: 0o700 });
    const stat = fs.lstatSync(isolatedConfigDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Unsafe login configuration directory");
    fs.chmodSync(isolatedConfigDir, 0o700);
    const args = ["auth", "login"];
    if (options.sso) args.push("--sso");
    if (options.console) args.push("--console");
    if (options.email) args.push("--email", options.email);
    // Browser authentication is the native default; no --browser flag exists upstream.
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "TERM", "COLORTERM", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "BROWSER", "SystemRoot", "WINDIR", "PATHEXT"]) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    env.HOME = authDir;
    env.CLAUDE_CONFIG_DIR = isolatedConfigDir;
    process.stderr.write("Claude login: complete the authorization URL in a browser; paste the displayed code if the native CLI asks.\n");
    const result = spawnSync("claude", args, { env, stdio: [0, 2, 2] });
    if (result.error) throw new Error("Unable to start native Claude login");
    if (result.status !== 0) throw new Error(`claude login exited with status ${result.status}`);
    return runImport(path.join(isolatedConfigDir, ".credentials.json"));
}
