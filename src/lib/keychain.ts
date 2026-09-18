import { config } from "../config";
import type { KeychainTokens, CredentialsFile } from "../types/auth";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

// macOS: keychain "Claude Code-credentials"
function readMacKeychain(): CredentialsFile | null {
    try {
        const user = os.userInfo().username;
        const raw = execSync(
            `security find-generic-password -a "${user}" -s "Claude Code-credentials" -w`,
            { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        );
        return JSON.parse(raw.trim());
    } catch {
        return null;
    }
}

function deleteMacKeychain(): boolean {
    try {
        const user = os.userInfo().username;
        execSync(
            `security delete-generic-password -a "${user}" -s "Claude Code-credentials"`,
            { stdio: ["pipe", "pipe", "pipe"] },
        );
        return true;
    } catch {
        return false;
    }
}

// Linux / fallback: ~/.claude/.credentials.json plaintext
function getPlaintextPath(): string {
    return path.join(config.claudeHome, ".credentials.json");
}

function readPlaintext(): CredentialsFile | null {
    const p = getPlaintextPath();
    try {
        return JSON.parse(fs.readFileSync(p, "utf-8"));
    } catch {
        return null;
    }
}

function deletePlaintext(): boolean {
    const p = getPlaintextPath();
    try {
        // Remove only claudeAiOauth key, keep other data (mcpOAuth etc)
        const data = JSON.parse(fs.readFileSync(p, "utf-8"));
        if (data.claudeAiOauth) {
            delete data.claudeAiOauth;
            fs.writeFileSync(p, JSON.stringify(data, null, 2), { mode: 0o600 });
        }
        return true;
    } catch {
        return false;
    }
}

// Unified interface — tries platform-native first, falls back to plaintext
export function readClaudeCredentials(): KeychainTokens | null {
    let creds: CredentialsFile | null = null;

    if (process.platform === "darwin") {
        creds = readMacKeychain();
    }
    // Fallback to plaintext (Linux, or macOS if keychain empty)
    if (!creds?.claudeAiOauth) {
        creds = readPlaintext();
    }

    return creds?.claudeAiOauth ?? null;
}

export function deleteClaudeCredentials(): boolean {
    let deleted = false;
    if (process.platform === "darwin") {
        deleted = deleteMacKeychain();
    }
    // Always clean plaintext too (macOS fallback writes there)
    if (deletePlaintext()) deleted = true;
    return deleted;
}
