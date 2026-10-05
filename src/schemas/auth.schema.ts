import { z } from "zod";
import {
    canonicalOAuthContractSchema,
    authStatusContractSchema,
    tokenWizardContractSchema,
} from "./contracts.schema";

export const tokenResponseSchema = z.object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    expires_in: z.number().finite().positive(),
    scope: z.string().optional(),
});
export type TokenResponse = z.infer<typeof tokenResponseSchema>;

export const authResultSchema = z.object({
    accessToken: z.string().min(1),
    subscriptionType: z.string().nullable(),
    rateLimitTier: z.string().nullable(),
});
export type AuthResult = z.infer<typeof authResultSchema>;

export const keychainTokensSchema = z.object({
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1),
    expiresAt: z.number().finite(),
    scopes: z.array(z.string()).optional(),
    subscriptionType: z.string().nullable().optional(),
    rateLimitTier: z.string().nullable().optional(),
});
export type KeychainTokens = z.infer<typeof keychainTokensSchema>;

export const credentialsFileSchema = z.object({
    claudeAiOauth: keychainTokensSchema.optional(),
});
export type CredentialsFile = z.infer<typeof credentialsFileSchema>;

export const oAuthEntrySchema = canonicalOAuthContractSchema;
export type OAuthEntry = z.infer<typeof oAuthEntrySchema>;

export const authStatusSchema = authStatusContractSchema;
export type AuthStatus = z.infer<typeof authStatusSchema>;

export const tokenWizardValuesSchema = tokenWizardContractSchema;
export type TokenWizardValues = z.infer<typeof tokenWizardValuesSchema>;

/**
 * Raw input validation and normalization for credentials (native Claude Linux/macOS or normalized OAuth).
 */
export function validateAndNormalizeAuth(data: unknown): OAuthEntry {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("Invalid credential schema");
    }
    const root = data as Record<string, unknown>;
    const isNative = Object.hasOwn(root, "claudeAiOauth");
    const candidate = isNative ? root.claudeAiOauth : root;

    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new Error("Invalid credential schema");
    }

    const obj = candidate as Record<string, unknown>;
    if (!isNative && obj.type !== "oauth") {
        throw new Error("Invalid credential schema");
    }

    const access = (isNative ? obj.accessToken : obj.access) ?? "";
    const refresh = (isNative ? obj.refreshToken : obj.refresh) ?? "";

    if (typeof access !== "string" || typeof refresh !== "string" || (!access.trim() && !refresh.trim())) {
        throw new Error("Invalid credential: missing access/refresh");
    }

    const rawExpiry = isNative ? obj.expiresAt : obj.expires;
    if (
        (rawExpiry === undefined && access.trim()) ||
        (rawExpiry !== undefined && (typeof rawExpiry !== "number" || !Number.isFinite(rawExpiry) || !Number.isFinite(new Date(rawExpiry).getTime())))
    ) {
        throw new Error("Invalid credential expiry");
    }

    if (obj.scopes !== undefined && (!Array.isArray(obj.scopes) || !obj.scopes.every((s: unknown) => typeof s === "string"))) {
        throw new Error("Invalid credential scopes");
    }

    for (const key of ["subscriptionType", "rateLimitTier"]) {
        if (obj[key] !== undefined && obj[key] !== null && typeof obj[key] !== "string") {
            throw new Error("Invalid credential metadata");
        }
    }

    const parsed = oAuthEntrySchema.safeParse({
        type: "oauth",
        access,
        refresh,
        expires: rawExpiry ?? 0,
        ...(obj.scopes === undefined ? {} : { scopes: [...(obj.scopes as string[])] }),
        subscriptionType: (obj.subscriptionType as string | null) ?? null,
        rateLimitTier: (obj.rateLimitTier as string | null) ?? null,
    });

    if (!parsed.success) {
        throw new Error("Invalid credential schema");
    }

    return parsed.data;
}
