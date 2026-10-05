import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import {
    ensureAuthDir,
    normalizeAndSave,
    getStatus,
} from "./lib/auth-storage";
import type { AuthStatus } from "./types/auth";

export interface RunLoginOptions {
    browser?: boolean;
    sso?: boolean;
    console?: boolean;
    email?: string;
}

export function runStatus(): AuthStatus {
    return getStatus();
}

export function runImport(source: string): AuthStatus {
    let content = "";
    if (source === "-") {
        content = fs.readFileSync(0, "utf-8");
    } else {
        if (!fs.existsSync(source)) {
            throw new Error(`Import file not found: ${source}`);
        }
        const lstat = fs.lstatSync(source);
        if (lstat.isSymbolicLink()) {
            throw new Error(`Insecure file: ${source} is a symbolic link`);
        }
        if (!lstat.isFile()) {
            throw new Error(`Insecure file: ${source} is not a regular file`);
        }
        content = fs.readFileSync(source, "utf-8");
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(content);
    } catch (err: any) {
        throw new Error(`Failed to parse import JSON: ${err.message}`);
    }

    normalizeAndSave(parsed);
    return getStatus();
}

export function runLogin(options: RunLoginOptions = {}): AuthStatus {
    const authDir = ensureAuthDir();
    const isolatedConfigDir = path.join(authDir, ".claude");
    if (!fs.existsSync(isolatedConfigDir)) {
        fs.mkdirSync(isolatedConfigDir, { recursive: true, mode: 0o700 });
    }

    // CLI executable: 'claude auth login'
    const args = ["auth", "login"];
    if (options.sso) {
        args.push("--sso");
    }
    if (options.console) {
        args.push("--console");
    }
    if (options.email) {
        args.push("--email", options.email);
    }

    const childEnv = {
        ...process.env,
        CLAUDE_CONFIG_DIR: isolatedConfigDir,
        HOME: authDir,
    };

    const proc = spawnSync("claude", args, {
        stdio: ["inherit", "pipe", "inherit"],
        env: childEnv,
    });

    if (proc.error) {
        throw new Error(`Failed to spawn claude login: ${proc.error.message}`);
    }
    if (proc.status !== 0) {
        throw new Error(`claude login exited with status ${proc.status}`);
    }

    // Look for generated credentials in isolatedConfigDir/.credentials.json
    const generatedCredentials = path.join(isolatedConfigDir, ".credentials.json");
    if (!fs.existsSync(generatedCredentials)) {
        throw new Error(
            `Expected login credentials at ${generatedCredentials} not found after login`,
        );
    }

    const raw = fs.readFileSync(generatedCredentials, "utf-8");
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err: any) {
        throw new Error(`Failed to parse credentials JSON: ${err.message}`);
    }

    normalizeAndSave(parsed);
    return getStatus();
}
