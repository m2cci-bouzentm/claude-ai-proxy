import fs from "fs";
import path from "path";
import { config } from "../config";
import type { OAuthEntry } from "../types/auth";

const AUTH_DIR = config.authDir;
export const AUTH_FILE = path.join(AUTH_DIR, "auth.json");

export function read(): OAuthEntry | null {
    if (!fs.existsSync(AUTH_FILE)) return null;
    return JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8"));
}

export function write(entry: OAuthEntry) {
    if (!fs.existsSync(AUTH_DIR))
        fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(AUTH_FILE, JSON.stringify(entry, null, 2), {
        mode: 0o600,
    });
}
