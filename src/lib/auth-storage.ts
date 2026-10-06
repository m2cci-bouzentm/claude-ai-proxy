import fs from "fs"
import path from "path"
import { randomUUID } from "crypto"
import type { OAuthEntry, AuthStatus } from "../types/auth"
import { validateAndNormalizeAuth, authStatusSchema } from "../schemas/auth.schema"

export function getAuthDir(): string {
  return process.env.PROXY_AUTH_DIR || process.env.CLAUDE_PROXY_HOME || "/data"
}
export function getAuthFile(): string {
  return path.join(getAuthDir(), "auth.json")
}
export const AUTH_FILE = getAuthFile()
const MAX_BYTES = 64 * 1024
export function secureDirectory(dir: string, create = false): string {
  if (create) {
    try {
      fs.lstatSync(dir)
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
  }
  const stat = fs.lstatSync(dir)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Insecure directory: symlink or not directory")
  if (process.getuid && stat.uid !== process.getuid()) throw new Error("Insecure directory owner")
  fs.chmodSync(dir, 0o700)
  return dir
}
export function ensureAuthDir(): string {
  return secureDirectory(getAuthDir(), true)
}
export function assertSafeFile(file: string): void {
  let stat
  try {
    stat = fs.lstatSync(file)
  } catch (e: any) {
    if (e.code === "ENOENT") return
    throw e
  }
  if (stat.isSymbolicLink()) throw new Error("Insecure file: symlink")
  if (!stat.isFile()) throw new Error("Insecure file: not regular file")
  if (process.getuid && stat.uid !== process.getuid()) throw new Error("Insecure file owner")
}
export function readSecureJson(file: string): { data: unknown; generation: string } {
  secureDirectory(path.dirname(file))
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  try {
    const stat = fs.fstatSync(fd, { bigint: true })
    if (!stat.isFile() || stat.size > BigInt(MAX_BYTES) || (process.getuid && stat.uid !== BigInt(process.getuid())))
      throw new Error("Insecure credential file")
    const buffer = Buffer.alloc(MAX_BYTES + 1)
    let size = 0,
      count
    while (size < buffer.length && (count = fs.readSync(fd, buffer, size, buffer.length - size, null)) > 0)
      size += count
    if (size > MAX_BYTES) throw new Error("Credential file too large")
    const raw = buffer.subarray(0, size).toString("utf8")
    return {
      data: JSON.parse(raw),
      generation: `${file}:${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${raw}`,
    }
  } finally {
    fs.closeSync(fd)
  }
}
export function normalize(data: unknown): OAuthEntry {
  return validateAndNormalizeAuth(data)
}
export function readSnapshot(): { entry: OAuthEntry; generation: string } | null {
  try {
    const result = readSecureJson(getAuthFile())
    return { entry: normalize(result.data), generation: result.generation }
  } catch {
    return null
  }
}
export function read(): OAuthEntry | null {
  return readSnapshot()?.entry ?? null
}
export function canonicalMissing(): boolean {
  try {
    fs.lstatSync(getAuthFile())
    return false
  } catch (e: any) {
    if (e.code === "ENOENT") return true
    throw e
  }
}
export function write(input: OAuthEntry): void {
  const entry = normalize(input)
  const raw = JSON.stringify(entry, null, 2)
  if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error("Credential file too large")
  const dir = ensureAuthDir(),
    file = getAuthFile()
  assertSafeFile(file)
  const temp = path.join(dir, `.auth.json.tmp.${randomUUID()}`)
  let created = false
  try {
    const fd = fs.openSync(temp, "wx", 0o600)
    created = true
    try {
      fs.fchmodSync(fd, 0o600)
      fs.writeFileSync(fd, raw, "utf8")
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    assertSafeFile(file)
    fs.renameSync(temp, file)
  } finally {
    if (created) fs.rmSync(temp, { force: true })
  }
}
export function normalizeAndSave(data: unknown): OAuthEntry {
  const entry = normalize(data)
  write(entry)
  return entry
}
export function getStatus(): AuthStatus {
  const entry = read()
  const status: AuthStatus = {
    configured: !!entry,
    type: entry?.type ?? null,
    provider: "claude",
    expiresAt: entry ? new Date(entry.expires).toISOString() : null,
    isExpired: entry ? entry.expires <= Date.now() : false,
    accessPresent: !!entry?.access,
    refreshPresent: !!entry?.refresh,
    accountIdPresent: false,
    subscriptionType: entry?.subscriptionType ?? null,
    rateLimitTier: entry?.rateLimitTier ?? null,
  }
  return authStatusSchema.parse(status)
}
